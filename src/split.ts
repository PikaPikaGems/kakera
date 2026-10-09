import type { Manifest, ManifestFile } from "./types.js";
// Node only: cut big files into parts that any static host accepts, plus a manifest.json for files.js.
// GitHub rejects files over 100 MB and Cloudflare Pages over 25 MiB, so parts are at most 20 MiB *before*
// compression. Each part is gzipped on its own (so it can be checked and unpacked alone), unless gzip saves less
// than 10% for that file (e.g. a voice model), in which case it is stored as is.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { MANIFEST_FORMAT } from "./files.js";

export const DEFAULT_PART_BYTES = 20 * 1024 * 1024;
export const HOST_LIMIT_BYTES = 25 * 1024 * 1024; // Cloudflare Pages, the strictest host we target

const sha256 = (buf: Uint8Array) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Write `bytes` as parts into `outDir`.
 * @param {Uint8Array} bytes
 * @param {{ name: string, outDir: string, partBytes?: number, gzip?: boolean | "auto" }} o
 * @returns {{ name: string, size: number, gzip: boolean, parts: { file: string, size: number, rawSize: number, sha256: string }[] }}
 */
export function splitFile(bytes: Uint8Array, { name, outDir, partBytes = DEFAULT_PART_BYTES, gzip = "auto" }: { name: string; outDir: string; partBytes?: number; gzip?: boolean | "auto" }): ManifestFile {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`file name "${name}" may only contain letters, digits, ".", "_" and "-"`);
  const pieces = [];
  for (let i = 0; i < bytes.length || i === 0; i += partBytes) pieces.push(bytes.subarray(i, i + partBytes));
  const packed = pieces.map((p) => zlib.gzipSync(p, { level: 9 }));
  const packedSize = packed.reduce((a, p) => a + p.length, 0);
  const useGzip = gzip === "auto" ? packedSize < bytes.length * 0.9 : gzip;

  fs.mkdirSync(outDir, { recursive: true });
  const parts = pieces.map((raw, i) => {
    const data = useGzip ? packed[i] : raw;
    const file = `${name}.part${String(i + 1).padStart(3, "0")}${useGzip ? ".gz" : ""}`;
    if (data.length > HOST_LIMIT_BYTES) throw new Error(`${file} is ${data.length} bytes, over the 25 MiB host limit; use a smaller part size`);
    fs.writeFileSync(path.join(outDir, file), data);
    return { file, size: data.length, rawSize: raw.length, sha256: sha256(data) };
  });
  return { name, size: bytes.length, gzip: useGzip, parts };
}

/**
 * Write manifest.json for files made by splitFile().
 * @param {string} outDir
 * @param {{ name: string, version: string, files: object[], meta?: object }} o
 *   name: what the files are (also the storage key prefix); version: changes whenever the files change
 */
export function writeManifest(outDir: string, { name, version, files, meta }: { name: string; version: string; files: ManifestFile[]; meta?: Record<string, unknown> }): Manifest {
  const manifest = {
    format: MANIFEST_FORMAT,
    name,
    version,
    downloadSize: files.reduce((a, f) => a + f.parts.reduce((b, p) => b + p.size, 0), 0),
    files,
    ...(meta ? { meta } : {}),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** A version string that changes whenever any of the given buffers changes. */
export const contentVersion = (...buffers: Uint8Array[]) => {
  const h = crypto.createHash("sha256");
  for (const b of buffers) h.update(b);
  return h.digest("hex").slice(0, 12);
};
