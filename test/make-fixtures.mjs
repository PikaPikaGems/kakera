// Writes test/fixtures/ (split files + manifest) for test/host.html:  node test/make-fixtures.mjs
import crypto from "node:crypto";
import { splitFile, writeManifest } from "../src/split.js";

const outDir = new URL("./fixtures/", import.meta.url).pathname;
const PART = 64 * 1024;
const model = new Uint8Array(crypto.randomBytes(200_000));
const dict = new TextEncoder().encode("吾輩は猫である。".repeat(20_000));
const files = [
  splitFile(model, { name: "model.bin", outDir, partBytes: PART }),
  splitFile(dict, { name: "dict.bin", outDir, partBytes: PART }),
];
const m = writeManifest(outDir, { name: "testengine", version: "v1", files });
console.log(`wrote ${outDir}manifest.json: ${files.map((f) => `${f.name} ${f.size} bytes in ${f.parts.length} parts`).join(", ")}; download ${m.downloadSize} bytes`);
