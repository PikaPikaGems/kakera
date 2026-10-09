// Load files written by `kakera split`: download their parts, check them, keep them on the device, and hand the
// (unpacked) bytes over piece by piece. Runs on the page, in workers and in Node (with an injected storage).
//
// The compressed parts are what is stored, so the device keeps the smaller form; each load unpacks them one part at a
// time and passes the pieces to `onFile`, which can stream them somewhere (e.g. straight into wasm memory) without a
// second full copy ever existing. Peak extra memory is about one part (≤ 20 MB).
//
// manifest.json (format "kakera/1"):
//   { format, name, version, downloadSize, meta?,
//     files: [{ name, size, gzip, parts: [{ file, size, rawSize, sha256 }] }] }
//   size/rawSize: unpacked bytes; part size: bytes on the server; sha256: of the bytes on the server.
//
// Storage layout (one store per package, e.g. IndexedDB database "yomiage"):
//   "<name>@<version>/<part file>"   bytes of one part, as downloaded
//   "<name>@<version>"               the manifest, written last: its presence means every part is stored
//   "manifest:<manifest url>"        the last manifest seen at that URL, so stored files also load offline
import { codedError, errorFields } from "./errors.js";

import type { Manifest, ManifestFile, FilePart, FileProgress, ByteChunks } from "./types.js";
/** Values are trusted at this local storage boundary; callers choose the stored value type. */
export interface FileStorage {
  get<T = unknown>(key: IDBValidKey): Promise<T | undefined>;
  put(key: IDBValidKey, value: unknown): Promise<unknown>;
  keys(): Promise<IDBValidKey[]>;
  remove(keys: IDBValidKey[]): Promise<void>;
}
export interface FileLoadOptions {
  onFile(file: ManifestFile, chunks: AsyncIterable<Uint8Array>, manifest: Manifest): void | Promise<void>;
  onProgress?(progress: FileProgress): void;
  log?(message: string): void;
}
export interface FileLoadResult { manifest: Manifest; fromCache: boolean; cached: boolean }

export const MANIFEST_FORMAT = "kakera/1";

// ------------------------------------------------------------------------------------------------ storage

/** Key/value storage in IndexedDB (one database per package, one object store). */
export function indexedDbStorage(dbName?: string): FileStorage {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(String(dbName), 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction("files", mode);
        const req = fn(t.objectStore("files"));
        t.oncomplete = () => resolve(req?.result as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
  };
  return {
    get: <T = unknown>(key: IDBValidKey) => tx<T | undefined>("readonly", (s) => s.get(key)),
    put: (key, value) => tx("readwrite", (s) => s.put(value, key)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
    remove: (keys) => (keys.length ? tx("readwrite", (s) => { for (const k of keys) s.delete(k); }) : Promise.resolve()),
  };
}

/** Storage in a Map (tests, or environments without IndexedDB). */
export function memoryStorage(): FileStorage & { map: Map<IDBValidKey, unknown> } {
  const m = new Map<IDBValidKey, unknown>();
  return {
    get: async <T = unknown>(key: IDBValidKey) => m.get(key) as T | undefined,
    put: async (key, value) => { m.set(key, value); },
    keys: async () => [...m.keys()],
    remove: async (keys) => { for (const k of keys) m.delete(k); },
    map: m,
  };
}

// ------------------------------------------------------------------------------------------------ helpers

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};

async function* gunzip(bytes: Uint8Array<ArrayBuffer>) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Gather streamed pieces into one buffer of a known size. */
export async function collect(chunks: ByteChunks, size: number) {
  const out = new Uint8Array(size);
  let n = 0;
  for await (const c of chunks) {
    if (n + c.length > size) throw codedError("checksum-mismatch", `file is larger than the manifest says (${size} bytes)`);
    out.set(c, n);
    n += c.length;
  }
  if (n !== size) throw codedError("checksum-mismatch", `file is ${n} bytes, the manifest says ${size}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ store

/**
 * @param {object} o
 * @param {string} [o.dbName]   IndexedDB database name (the package's name); ignored when `storage` is given
 * @param {object} [o.storage]  { get, put, keys, remove } (default: IndexedDB)
 * @param {typeof fetch} [o.fetch]
 */
export function fileStore({ dbName, storage: suppliedStorage, fetch: fetchFn }: { dbName?: string; storage?: FileStorage; fetch?: typeof fetch } = {}) {
  const storage = suppliedStorage ?? indexedDbStorage(dbName);
  const doFetch: typeof fetch = fetchFn ?? ((...a) => fetch(...a));
  const idOf = (m: Manifest) => `${m.name}@${m.version}`;

  async function getManifest(url: string): Promise<Manifest> {
    try {
      const res = await doFetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const m = await res.json() as Manifest;
      if (m.format !== MANIFEST_FORMAT) throw new Error(`unknown manifest format ${m.format}`);
      storage.put(`manifest:${url}`, m).catch(() => {});
      return m;
    } catch (err) {
      const saved = await storage.get<Manifest>(`manifest:${url}`).catch(() => null);
      if (saved) return saved;
      throw codedError("download-failed", `could not load ${url}: ${errorFields(err).message}`);
    }
  }

  /** Delete stored parts of `name`, except those of `keepId` (all of them when keepId is null). */
  async function removeName(name: string, keepId: string | null) {
    const keys = await storage.keys();
    await storage.remove(keys.filter((k) => typeof k === "string" && k.startsWith(`${name}@`)
      && (!keepId || (k !== keepId && !k.startsWith(`${keepId}/`)))));
  }

  async function download(url: string | URL, expected: number, onBytes: (bytes: number) => void) {
    let res;
    try { res = await doFetch(url); } catch (e) { throw codedError("download-failed", `${url}: ${errorFields(e).message}`); }
    if (!res.ok) throw codedError("download-failed", `${url}: ${res.status} ${res.statusText}`);
    const out = new Uint8Array(expected);
    const reader = res.body!.getReader();
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > expected) throw codedError("download-failed", `${url} is larger than the manifest says`);
        out.set(value, n);
        n += value.length;
        onBytes(value.length);
      }
    } catch (e) {
      throw errorFields(e).code ? e : codedError("download-failed", `${url}: ${errorFields(e).message}`);
    }
    if (n !== expected) throw codedError("download-failed", `${url}: got ${n} bytes, the manifest says ${expected}`);
    return out;
  }

  return {
    /** Is everything stored on the device, and how big is the download if not? */
    async info(manifestUrl: string) {
      const m = await getManifest(manifestUrl);
      const cached = !!(await storage.get(idOf(m)).catch(() => null));
      return { cached, downloadBytes: m.downloadSize, manifest: m };
    },

    /** Describe which manifest parts are stored without reading their contents. */
    async diagnostics(manifestUrl: string) {
      const manifest = await getManifest(manifestUrl);
      const id = idOf(manifest);
      let keys: Set<IDBValidKey> | null = null, complete: boolean | "unknown" = "unknown";
      try { keys = new Set(await storage.keys()); } catch { /* storage may be blocked */ }
      try { complete = !!(await storage.get(id)); } catch { /* storage may be blocked */ }
      const files = manifest.files.map((file) => {
        const parts = file.parts.map((part) => ({
          file: part.file,
          cached: keys ? keys.has(`${id}/${part.file}`) : "unknown" as const,
        }));
        return { name: file.name, parts };
      });
      return {
        manifest: { name: manifest.name, version: manifest.version, format: manifest.format },
        cached: complete,
        files,
      };
    },

    /** Delete everything stored for the manifest's name (all versions). */
    async clear(manifestUrl: string) {
      const m = await getManifest(manifestUrl);
      await removeName(m.name, null);
    },

    /**
     * Go through the manifest's files in order. For each, `onFile(file, chunks)` gets the file's entry and an async
     * iterable of its unpacked bytes; it should consume them (whatever it leaves is read and dropped).
     *
     * `onProgress` is called at every step, and while bytes arrive (at most every 100 ms), with:
     *   step        "manifest" | "read" (a part from the device) | "download" | "verify" | "store" | "unpack" | "file-done"
     *   file, fileIndex, files      the file being worked on (1-based index) and how many files there are
     *   part, parts                 the part of that file (1-based) and how many it has
     *   downloaded, toDownload      bytes; toDownload counts only the parts not on the device (0 when all are)
     *   unpacked, toUnpack          bytes handed to onFile so far / in all files
     * @param {string} manifestUrl  absolute URL
     * @param {object} o
     * @param {(file: object, chunks: AsyncIterable<Uint8Array>, manifest: object) => Promise<void>} o.onFile
     * @param {(p: object) => void} [o.onProgress]
     * @param {(msg: string) => void} [o.log]
     * @returns {Promise<{ manifest: object, fromCache: boolean, cached: boolean }>}
     *   fromCache: nothing was downloaded; cached: everything is now stored on the device
     */
    async load(manifestUrl: string, { onFile, onProgress = () => {}, log = () => {} }: FileLoadOptions): Promise<FileLoadResult> {
      if (typeof DecompressionStream !== "function") throw codedError("unsupported-browser", "this browser cannot unpack gzip (needs Safari 16.4+ or a recent Chrome/Firefox)");
      const where: { file: string | null; fileIndex: number; files: number; part: number; parts: number } = { file: null, fileIndex: 0, files: 0, part: 0, parts: 0 };
      const counts = { downloaded: 0, toDownload: 0, unpacked: 0, toUnpack: 0 };
      const report = (step: string) => onProgress({ step, ...where, ...counts });
      report("manifest");
      const m = await getManifest(manifestUrl);
      const id = idOf(m);
      const complete = !!(await storage.get(id).catch(() => null));
      const verify = !!globalThis.crypto?.subtle; // missing on plain http:// LAN addresses
      if (!complete && !verify) log("No crypto.subtle (page is not https): skipping checksum verification.");

      // which parts have to be downloaded (for an honest progress bar, also when some are already stored)
      const stored = new Set(complete ? [] : await storage.keys().catch(() => []));
      where.files = m.files.length;
      counts.toUnpack = m.files.reduce((n, f) => n + f.size, 0);
      counts.toDownload = complete ? 0 : m.files.flatMap((f) => f.parts).filter((p) => !stored.has(`${id}/${p.file}`)).reduce((n, p) => n + p.size, 0);

      let storing = true, downloaded = false, lastReport = 0;

      /** Bytes of one part as on the server: from the device, or downloaded, checked and stored. */
      const partBytes = async ({ file: name, size, sha256 }: FilePart) => {
        const key = `${id}/${name}`;
        report("read");
        const fromDevice = await storage.get<ArrayBuffer>(key).catch(() => null);
        if (fromDevice) return new Uint8Array(fromDevice);
        if (complete) {
          log(`${name} was missing from the device; downloading it again.`);
          counts.toDownload += size;
        }
        downloaded = true;
        report("download");
        const bytes = await download(new URL(name, manifestUrl), size, (n) => {
          counts.downloaded += n;
          const now = Date.now();
          if (now - lastReport >= 100) { lastReport = now; report("download"); }
        });
        report("download"); // the part is complete
        if (verify) {
          report("verify");
          if ((await sha256Hex(bytes)) !== sha256) throw codedError("checksum-mismatch", `${name} is corrupt (checksum mismatch); reload to try again`);
        }
        if (storing) {
          report("store");
          try { await storage.put(key, bytes.buffer); }
          catch (e) { storing = false; log(`Could not store the files on this device (${errorFields(e).name ?? e}); they will download again next time.`); }
        }
        return bytes;
      };

      for (const [i, file] of m.files.entries()) {
        Object.assign(where, { file: file.name, fileIndex: i + 1, part: 0, parts: file.parts.length });
        let written = 0;
        const chunks = (async function* () {
          for (const [j, part] of file.parts.entries()) {
            where.part = j + 1;
            const bytes = await partBytes(part);
            report("unpack");
            if (file.gzip) for await (const c of gunzip(bytes)) { written += c.length; counts.unpacked += c.length; yield c; }
            else { written += bytes.length; counts.unpacked += bytes.length; yield bytes; }
          }
          if (written !== file.size) throw codedError("checksum-mismatch", `${file.name} unpacked to ${written} bytes, the manifest says ${file.size}`);
        })();
        await onFile(file, chunks, m);
        for await (const _ of chunks) { /* drain anything the consumer left */ }
        report("file-done");
      }

      if (!complete && storing) {
        try {
          await storage.put(id, m); // marks the stored copy complete
          await removeName(m.name, id); // drop older versions
        } catch (e) { storing = false; log(`Could not finish storing the files (${errorFields(e).name ?? e}).`); }
      }
      return { manifest: m, fromCache: !downloaded, cached: complete || storing };
    },
  };
}
