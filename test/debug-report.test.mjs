import assert from "node:assert/strict";
import { test } from "node:test";
import { createPool, fileStore, KakeraError, memoryStorage } from "../dist/index.js";

test("file diagnostics list cached and missing parts without reading file data", async () => {
  const manifest = {
    format: "kakera/1", name: "voice", version: "1.2.3", downloadSize: 30,
    files: [{ name: "model.onnx", size: 60, parts: [
      { file: "model.onnx.part001", size: 10 }, { file: "model.onnx.part002", size: 20 },
    ] }],
  };
  const storage = memoryStorage();
  await storage.put("voice@1.2.3/model.onnx.part001", new Uint8Array([1]).buffer);
  const store = fileStore({ storage, fetch: async () => new Response(JSON.stringify(manifest)) });
  const result = await store.diagnostics("https://example.test/voice/manifest.json");
  assert.equal(result.cached, false);
  assert.deepEqual(result.files[0].parts.map((part) => part.cached), [true, false]);
});

test("debugReport survives a failed load and never includes call text", async () => {
  const saved = new Map(["location", "Worker", "indexedDB", "navigator", "fetch", "localStorage", "sessionStorage"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };

  class FakeWorker {
    postMessage(message) {
      if (message.type === "load") queueMicrotask(() => this.onmessage({ data: {
        id: message.id, type: "error", code: "download-failed", message: "manifest file is missing",
      } }));
    }
    terminate() {}
  }
  try {
    globalThis.location = { href: "https://example.test/app/" };
    globalThis.Worker = FakeWorker;
    globalThis.indexedDB = { open() { throw new Error("storage blocked"); } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      userAgent: "Test browser", deviceMemory: 4,
      storage: { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false },
    } });
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {}, get length() { return 0; }, key() { return null; } };
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });

    const pool = createPool({ prefix: "debug-test", ErrorClass: KakeraError });
    const handle = pool.handle({ name: "engine", filesUrl: "/missing/", createWorker: () => new FakeWorker() });
    await assert.rejects(handle.load(), (err) => err.code === "download-failed");
    const secret = "私の入力した文章";
    await assert.rejects(handle.call("analyze", { text: secret }));
    const report = await handle.debugReport({ packageName: "wakachi", packageVersion: "1.2.3" });

    assert.match(report, /"version": "1\.2\.3"/);
    assert.match(report, /"kakeraVersion": "0\.0\.0"/);
    assert.match(report, /"manifestMatchesPackage": "unknown"/);
    assert.match(report, /"status": "error"/);
    assert.match(report, /"code": "download-failed"/);
    assert.match(report, /"usage": 10/);
    assert.match(report, /manifest file is missing/);
    assert.doesNotMatch(report, new RegExp(secret));
  } finally { restore(); }
});
