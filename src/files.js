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
import { codedError } from "./errors.js";

export const MANIFEST_FORMAT = "kakera/1";

// ------------------------------------------------------------------------------------------------ storage

/** Key/value storage in IndexedDB (one database per package, one object store). */
export function indexedDbStorage(dbName) {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction("files", mode);
        const req = fn(t.objectStore("files"));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
  };
  return {
    get: (key) => tx("readonly", (s) => s.get(key)),
    put: (key, value) => tx("readwrite", (s) => s.put(value, key)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
    remove: (keys) => (keys.length ? tx("readwrite", (s) => { for (const k of keys) s.delete(k); }) : Promise.resolve()),
  };
}

/** Storage in a Map (tests, or environments without IndexedDB). */
export function memoryStorage() {
  const m = new Map();
  return {
    get: async (key) => m.get(key),
    put: async (key, value) => { m.set(key, value); },
    keys: async () => [...m.keys()],
    remove: async (keys) => { for (const k of keys) m.delete(k); },
    map: m,
  };
}

// ------------------------------------------------------------------------------------------------ helpers

const sha256Hex = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};

async function* gunzip(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Gather streamed pieces into one buffer of a known size. */
export async function collect(chunks, size) {
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
export function fileStore({ dbName, storage, fetch: fetchFn } = {}) {
  storage ??= indexedDbStorage(dbName);
  const doFetch = fetchFn ?? ((...a) => fetch(...a));
  const idOf = (m) => `${m.name}@${m.version}`;

  async function getManifest(url) {
    try {
      const res = await doFetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const m = await res.json();
      if (m.format !== MANIFEST_FORMAT) throw new Error(`unknown manifest format ${m.format}`);
      storage.put(`manifest:${url}`, m).catch(() => {});
      return m;
    } catch (err) {
      const saved = await storage.get(`manifest:${url}`).catch(() => null);
      if (saved) return saved;
      throw codedError("download-failed", `could not load ${url}: ${err.message}`);
    }
  }

  /** Delete stored parts of `name`, except those of `keepId` (all of them when keepId is null). */
  async function removeName(name, keepId) {
    const keys = await storage.keys();
    await storage.remove(keys.filter((k) => typeof k === "string" && k.startsWith(`${name}@`)
      && (!keepId || (k !== keepId && !k.startsWith(`${keepId}/`)))));
  }

  async function download(url, expected, onBytes) {
    let res;
    try { res = await doFetch(url); } catch (e) { throw codedError("download-failed", `${url}: ${e.message}`); }
    if (!res.ok) throw codedError("download-failed", `${url}: ${res.status} ${res.statusText}`);
    const out = new Uint8Array(expected);
    const reader = res.body.getReader();
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
      throw e.code ? e : codedError("download-failed", `${url}: ${e.message}`);
    }
    if (n !== expected) throw codedError("download-failed", `${url}: got ${n} bytes, the manifest says ${expected}`);
    return out;
  }

  return {
    /** Is everything stored on the device, and how big is the download if not? */
    async info(manifestUrl) {
      const m = await getManifest(manifestUrl);
      const cached = !!(await storage.get(idOf(m)).catch(() => null));
      return { cached, downloadBytes: m.downloadSize, manifest: m };
    },

    /** Delete everything stored for the manifest's name (all versions). */
    async clear(manifestUrl) {
      const m = await getManifest(manifestUrl);
      await removeName(m.name, null);
    },

    /**
     * Go through the manifest's files in order. For each, `onFile(file, chunks)` gets the file's entry and an async
     * iterable of its unpacked bytes; it should consume them (whatever it leaves is read and dropped).
     * @param {string} manifestUrl  absolute URL
     * @param {object} o
     * @param {(file: object, chunks: AsyncIterable<Uint8Array>, manifest: object) => Promise<void>} o.onFile
     * @param {(p: { loaded: number, total: number }) => void} [o.onProgress]  bytes downloaded (not called when stored)
     * @param {() => void} [o.onStep]   after each part (a "still working" signal)
     * @param {(msg: string) => void} [o.log]
     * @returns {Promise<{ manifest: object, fromCache: boolean, cached: boolean }>}
     *   fromCache: nothing was downloaded; cached: everything is now stored on the device
     */
    async load(manifestUrl, { onFile, onProgress = () => {}, onStep = () => {}, log = () => {} }) {
      if (typeof DecompressionStream !== "function") throw codedError("unsupported-browser", "this browser cannot unpack gzip (needs Safari 16.4+ or a recent Chrome/Firefox)");
      const m = await getManifest(manifestUrl);
      const id = idOf(m);
      const complete = !!(await storage.get(id).catch(() => null));
      const verify = !!globalThis.crypto?.subtle; // missing on plain http:// LAN addresses
      if (!complete && !verify) log("No crypto.subtle (page is not https): skipping checksum verification.");

      let storing = true, downloaded = false, loaded = 0;
      const total = m.downloadSize;

      /** Bytes of one part as on the server: from the device, or downloaded, checked and stored. */
      const partBytes = async ({ file: name, size, sha256 }) => {
        const key = `${id}/${name}`;
        const stored = await storage.get(key).catch(() => null);
        if (stored) return new Uint8Array(stored);
        if (complete) log(`${name} was missing from the device; downloading it again.`);
        downloaded = true;
        const bytes = await download(new URL(name, manifestUrl), size, (n) => { loaded += n; onProgress({ loaded, total }); });
        if (verify && (await sha256Hex(bytes)) !== sha256) throw codedError("checksum-mismatch", `${name} is corrupt (checksum mismatch); reload to try again`);
        if (storing) {
          try { await storage.put(key, bytes.buffer); }
          catch (e) { storing = false; log(`Could not store the files on this device (${e?.name ?? e}); they will download again next time.`); }
        }
        return bytes;
      };

      for (const file of m.files) {
        let written = 0;
        const chunks = (async function* () {
          for (const part of file.parts) {
            const bytes = await partBytes(part);
            if (file.gzip) for await (const c of gunzip(bytes)) { written += c.length; yield c; }
            else { written += bytes.length; yield bytes; }
            onStep();
          }
          if (written !== file.size) throw codedError("checksum-mismatch", `${file.name} unpacked to ${written} bytes, the manifest says ${file.size}`);
        })();
        await onFile(file, chunks, m);
        for await (const _ of chunks) { /* drain anything the consumer left */ }
      }

      if (!complete && storing) {
        try {
          await storage.put(id, m); // marks the stored copy complete
          await removeName(m.name, id); // drop older versions
        } catch (e) { storing = false; log(`Could not finish storing the files (${e?.name ?? e}).`); }
      }
      return { manifest: m, fromCache: !downloaded, cached: complete || storing };
    },
  };
}
