import assert from "node:assert/strict";
import { test } from "node:test";
import { engineStore } from "../dist/index.js";

/** A stand-in for an analyzer or a voice: status/progress events, info() and a load() the test resolves. */
function fakeEngine({ cached = false } = {}) {
  const listeners = { status: new Set(), progress: new Set() };
  const e = {
    status: "not-loaded", cached, loads: 0, infos: 0, fail: null,
    emit(event, value) { if (event === "status") e.status = value; for (const fn of listeners[event]) fn(value); },
    on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); },
    async info() { e.infos++; return { cached: e.cached, downloadBytes: 45e6, downloadMB: 45 }; },
    async load() {
      e.loads++;
      e.emit("status", "downloading");
      e.emit("progress", { stage: "downloading", fraction: 0.5 });
      await new Promise((r) => setTimeout(r, 5));
      if (e.fail) { e.emit("status", "error"); throw e.fail; }
      e.cached = true;
      e.emit("status", "ready");
      return { fromCache: false };
    },
    unload() { e.emit("status", "stopped"); },
    async clearCache() { e.cached = false; },
    async debugReport() { return "Debug report"; },
  };
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("nothing loads by itself; the first subscriber reads info()", async () => {
  const e = fakeEngine();
  const store = engineStore(e);
  assert.equal(e.infos, 0);
  assert.deepEqual(store.getSnapshot(), { status: "not-loaded", cached: null, downloadMB: null, progress: null, error: null });
  let changes = 0;
  store.subscribe(() => changes++);
  store.subscribe(() => {});
  await tick();
  assert.equal(e.infos, 1);
  assert.equal(e.loads, 0);
  assert.equal(changes, 1);
  assert.deepEqual(store.getSnapshot(), { status: "not-loaded", cached: false, downloadMB: 45, progress: null, error: null });
});

test("load: progress while loading, cleared when ready; snapshots are new objects only on change", async () => {
  const e = fakeEngine();
  const store = engineStore(e);
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  await tick();
  const before = store.getSnapshot();
  assert.equal(store.getSnapshot(), before);
  const loading = store.load();
  assert.equal(store.getSnapshot().status, "downloading");
  assert.deepEqual(store.getSnapshot().progress, { stage: "downloading", fraction: 0.5 });
  await loading;
  assert.deepEqual(store.getSnapshot(), { status: "ready", cached: true, downloadMB: 45, progress: null, error: null });
  assert.equal(new Set(seen).size, seen.length);
  store.unload();
  assert.equal(store.getSnapshot().status, "stopped");
});

test("a failed load never rejects: the error is kept until the next load()", async () => {
  const e = fakeEngine();
  e.fail = Object.assign(new Error("offline"), { code: "download-failed" });
  const store = engineStore(e);
  await store.load();
  assert.equal(store.getSnapshot().status, "error");
  assert.equal(store.getSnapshot().error.code, "download-failed");
  e.fail = null;
  const again = store.load();
  assert.equal(store.getSnapshot().error, null);
  await again;
  assert.equal(store.getSnapshot().status, "ready");
});

test("clearCache reads info() again", async () => {
  const e = fakeEngine({ cached: true });
  const store = engineStore(e);
  store.subscribe(() => {});
  await tick();
  assert.equal(store.getSnapshot().cached, true);
  await store.clearCache();
  assert.equal(store.getSnapshot().cached, false);
  assert.equal(await store.debugReport(), "Debug report");
});
