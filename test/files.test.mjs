// Split files into parts, serve them over HTTP, load them back: downloads, checks, storage, offline, re-downloads.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { collect, fileStore, memoryStorage } from "../src/files.js";
import { contentVersion, splitFile, writeManifest } from "../src/split.js";

const PART = 64 * 1024; // small parts so every file has several
const random = (n) => new Uint8Array(crypto.randomBytes(n)); // incompressible, like a voice model
const text = (n) => new TextEncoder().encode("吾輩は猫である。名前はまだ無い。".repeat(Math.ceil(n / 48))).subarray(0, n);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kakera-"));
const model = random(300_000); // does not compress: stored as is
const dict = text(500_000); // compresses well: gzip

function publish(version) {
  const files = [
    splitFile(model, { name: "model.bin", outDir: dir, partBytes: PART }),
    splitFile(dict, { name: "dict.bin", outDir: dir, partBytes: PART }),
  ];
  return writeManifest(dir, { name: "testpkg", version, files, meta: { hello: "world" } });
}

let server, base, requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    const file = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200);
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Load everything, returning each file's bytes and how many pieces it arrived in. */
async function loadAll(store, url = `${base}manifest.json`, extra = {}) {
  const got = {};
  const res = await store.load(url, {
    ...extra,
    onFile: async (file, chunks) => {
      let pieces = 0;
      const counted = (async function* () { for await (const c of chunks) { pieces++; yield c; } })();
      got[file.name] = { bytes: await collect(counted, file.size), pieces };
    },
  });
  return { ...res, got };
}

test("split: gzip only where it helps, parts within the size limit, manifest totals", () => {
  const m = publish(contentVersion(model, dict));
  const [mf, df] = m.files;
  assert.equal(mf.gzip, false);
  assert.equal(df.gzip, true);
  assert.equal(mf.parts.length, Math.ceil(model.length / PART));
  for (const p of [...mf.parts, ...df.parts]) assert.ok(p.rawSize <= PART);
  assert.equal(m.downloadSize, [...mf.parts, ...df.parts].reduce((a, p) => a + p.size, 0));
  assert.ok(df.parts.reduce((a, p) => a + p.size, 0) < dict.length / 3, "text compresses a lot");
});

test("first load downloads, checks and stores; data arrives in pieces", async () => {
  const storage = memoryStorage();
  const store = fileStore({ storage });
  let lastProgress;
  const res = await loadAll(store, undefined, { onProgress: (p) => { lastProgress = p; } });
  assert.deepEqual(res.got["model.bin"].bytes, model);
  assert.deepEqual(res.got["dict.bin"].bytes, dict);
  assert.ok(res.got["model.bin"].pieces > 1 && res.got["dict.bin"].pieces > 1, "streamed, not one big copy");
  assert.equal(res.fromCache, false);
  assert.equal(res.cached, true);
  assert.equal(lastProgress.loaded, lastProgress.total);
  assert.equal(res.manifest.meta.hello, "world");
  assert.equal((await store.info(`${base}manifest.json`)).cached, true);
  const diagnostics = await store.diagnostics(`${base}manifest.json`);
  assert.equal(diagnostics.manifest.version, res.manifest.version);
  assert.equal(diagnostics.cached, true);
  assert.ok(diagnostics.files.every((file) => file.parts.every((part) => part.cached)));
});

test("second load uses the device only, and works offline", async () => {
  const storage = memoryStorage();
  await loadAll(fileStore({ storage }));
  requests = [];
  const offline = fileStore({ storage, fetch: async () => { throw new Error("offline"); } });
  const res = await loadAll(offline);
  assert.equal(res.fromCache, true);
  assert.deepEqual(res.got["dict.bin"].bytes, dict);
  assert.deepEqual(requests, []);
});

test("a stored part that went missing is downloaded again", async () => {
  const storage = memoryStorage();
  await loadAll(fileStore({ storage }));
  const partKey = [...storage.map.keys()].find((k) => k.endsWith("dict.bin.part002.gz"));
  storage.map.delete(partKey);
  requests = [];
  const logs = [];
  const res = await loadAll(fileStore({ storage }), undefined, { log: (m) => logs.push(m) });
  assert.deepEqual(res.got["dict.bin"].bytes, dict);
  assert.equal(res.fromCache, false);
  assert.ok(requests.some((r) => r.includes("dict.bin.part002.gz")));
  assert.ok(logs.some((l) => /missing/.test(l)));
});

test("a corrupt part on the server is rejected", async () => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const victim = path.join(dir, m.files[1].parts[0].file);
  const original = fs.readFileSync(victim);
  const bad = Buffer.from(original); bad[10] ^= 0xff;
  fs.writeFileSync(victim, bad);
  try {
    await assert.rejects(loadAll(fileStore({ storage: memoryStorage() })), (e) => e.code === "checksum-mismatch");
  } finally { fs.writeFileSync(victim, original); }
});

test("a missing manifest is download-failed", async () => {
  await assert.rejects(loadAll(fileStore({ storage: memoryStorage() }), `${base}nope/manifest.json`), (e) => e.code === "download-failed");
});

test("a new version replaces the old one on the device", async () => {
  const storage = memoryStorage();
  await loadAll(fileStore({ storage }));
  const oldVersion = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version;
  publish("v2");
  try {
    const res = await loadAll(fileStore({ storage }));
    assert.equal(res.manifest.version, "v2");
    const keys = [...storage.map.keys()].filter((k) => !k.startsWith("manifest:"));
    assert.ok(keys.every((k) => k.startsWith("testpkg@v2")), `left over: ${keys.filter((k) => !k.startsWith("testpkg@v2"))}`);
    assert.ok(!keys.some((k) => k.includes(oldVersion)));
  } finally { publish(contentVersion(model, dict)); }
});

test("clear() deletes every stored version", async () => {
  const storage = memoryStorage();
  const store = fileStore({ storage });
  await loadAll(store);
  await store.clear(`${base}manifest.json`);
  assert.equal([...storage.map.keys()].filter((k) => !k.startsWith("manifest:")).length, 0);
  assert.equal((await store.info(`${base}manifest.json`)).cached, false);
});
