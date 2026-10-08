// Browser tests for createPool / handles (test/host.html). Results on the page and in window.__results.
import { createPool, KakeraError } from "../src/index.js";

class TestError extends KakeraError {}
const pool = createPool({ prefix: "kakera-test", ErrorClass: TestError });
const FILES = new URL("./fixtures/", location.href).href;
const createWorker = () => new Worker(new URL("./test-engine.js", import.meta.url), { type: "module" });
const make = (o = {}) => pool.handle({ name: "testengine", filesUrl: FILES, createWorker, ...o });
const phase = new URLSearchParams(location.search).get("phase") ?? "1";
const CRASH_KEY = `testengine|${new URL("manifest.json", FILES).href}`;

const results = [];
window.__results = results;
const list = document.getElementById("results");
async function t(name, fn) {
  const li = document.createElement("li");
  li.textContent = `${name} ...`;
  list.append(li);
  try {
    await fn();
    li.innerHTML = `<span class="ok">PASS</span> ${name}`;
    results.push({ name, ok: true });
  } catch (e) {
    li.innerHTML = `<span class="bad">FAIL</span> ${name}<pre>${e?.stack ?? e}</pre>`;
    results.push({ name, ok: false, error: String(e?.message ?? e) });
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const rejects = async (p, check) => { try { await p; } catch (e) { check(e); return; } throw new Error("expected a rejection"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workers = () => pool.engines().filter((e) => e.worker).length;

async function phase1() {
  localStorage.removeItem(`kakera-test:crashed:${CRASH_KEY}`);
  localStorage.removeItem(`kakera-test:timings:${CRASH_KEY}`);
  await new Promise((r) => { const q = indexedDB.deleteDatabase("kakera-test"); q.onsuccess = q.onerror = q.onblocked = r; });
  const a = make();

  await t("a call before load() rejects with not-loaded (as the package's error class)", async () => {
    eq(a.status, "not-loaded", "status");
    await rejects(a.call("echo", { value: 1 }), (e) => { eq(e.code, "not-loaded", "code"); assert(e instanceof TestError, "error class"); eq(e.name, "TestError", "name"); });
  });

  await t("info() before the first load: not cached, download size from the manifest", async () => {
    const i = await a.info();
    eq(i.cached, false, "cached");
    assert(i.downloadBytes > 0 && typeof i.downloadMB === "number", "sizes");
  });

  await t("load() downloads: statuses, detailed progress, timings, then ready", async () => {
    const seen = [], events = [], logs = [];
    const offs = [a.on("status", (s) => seen.push(s)), a.on("progress", (p) => events.push(p)), a.on("log", (m) => logs.push(m))];
    const res = await a.load();
    offs.forEach((off) => off());
    eq(res.fromCache, false, "fromCache");
    eq(a.status, "ready", "status");
    assert(seen.includes("downloading") && seen.at(-1) === "ready", `statuses ${seen}`);
    const stages = [...new Set(events.map((e) => e.stage))];
    eq(stages.join(), "downloading,preparing,ready", "stages in order");
    const steps = new Set(events.map((e) => e.step));
    for (const s of ["download", "verify", "store", "unpack", "file-done", "start-engine", "ready"]) assert(steps.has(s), `step ${s} missing (${[...steps]})`);
    assert(events.every((e, i) => i === 0 || e.fraction >= events[i - 1].fraction), "fraction never goes backwards");
    eq(events.at(-1).fraction, 1, "ends at 1");
    const dl = events.filter((e) => e.stage === "downloading");
    assert(dl.every((e) => e.total > 0 && e.loaded <= e.total), "download bytes");
    assert(events.some((e) => e.file === "model.bin" && e.parts > 1 && e.part >= 1), "file and part details");
    assert(res.ms >= 0 && res.timings.length > 5 && res.timings.every((x) => x.step && x.ms >= 0), "timings");
    eq(res.timings[0].step, "manifest", "first timing");
    assert(logs.some((m) => /download model\.bin part 1\//.test(m)), `step logs: ${logs.slice(0, 3)}`);
    eq((await a.info()).cached, true, "cached afterwards");
  });

  await t("loading from the device: preparing only, still a full bar", async () => {
    const events = [];
    const p = make();
    a.unload();
    const off = p.on("progress", (e) => events.push(e));
    const res = await p.load();
    off();
    eq(res.fromCache, true, "fromCache");
    eq([...new Set(events.map((e) => e.stage))].join(), "preparing,ready", "stages");
    assert(events.some((e) => e.step === "read") && !events.some((e) => e.step === "download"), "read, no download");
    assert(events.some((e) => e.fraction > 0.5 && e.fraction < 1), "bar moves while preparing");
    p.dispose();
    await a.load();
  });

  await t("step times are remembered; the next load from the device moves the bar by time", async () => {
    const saved = JSON.parse(localStorage.getItem(`kakera-test:timings:${CRASH_KEY}`) ?? "null");
    assert(saved && saved.total > 0 && Object.keys(saved.steps).some((k) => k.startsWith("start-engine")), "profile saved after a load from the device");
    const events = [];
    const p = make();
    a.unload();
    const off = p.on("progress", (e) => events.push(e));
    await p.load();
    off();
    assert(events.every((e, i) => i === 0 || e.fraction >= events[i - 1].fraction), "never backwards");
    eq(events.at(-1).fraction, 1, "ends at 1");
    p.dispose();
    await a.load();
  });

  await t("calls work; results can transfer buffers", async () => {
    const r = await a.call("echo", { value: 42 });
    eq(r.value, 42, "echo");
    eq(r.sizes["model.bin"], 200000, "model size");
    eq((await a.call("audio")).samples.length, 1000, "audio");
  });

  await t("one worker per engine, shared by handles", async () => {
    const b = make();
    eq((await b.load()).fromCache, true, "already loaded");
    eq(workers(), 1, "workers");
    b.dispose();
    eq(workers(), 1, "still loaded for the first handle");
  });

  await t("engine errors keep their codes; RangeError becomes out-of-memory", async () => {
    await rejects(a.call("oom"), (e) => eq(e.code, "out-of-memory", "code"));
    await rejects(a.call("coded", { code: "checksum-mismatch" }), (e) => eq(e.code, "checksum-mismatch", "code"));
  });

  await t("abort rejects with AbortError", async () => {
    const c = new AbortController();
    const p = a.call("busy", { ms: 300 }, { signal: c.signal });
    c.abort();
    await rejects(p, (e) => eq(e.name, "AbortError", "name"));
  });

  await t("a long call that reports progress never times out", async () => {
    eq(await a.call("busy", { ms: 600 }, { stall: 200 }), "finished", "result");
  });

  await t("a call without progress times out; the worker is stopped; the next call recovers", async () => {
    await rejects(a.call("silent", { ms: 1000 }, { stall: 150 }), (e) => eq(e.code, "timeout", "code"));
    eq(workers(), 0, "worker stopped");
    eq((await a.call("echo", { value: 1 })).value, 1, "recovered (reloaded from the device)");
  });

  await t("unload() frees the worker; the next call reloads from the device", async () => {
    a.unload();
    eq(a.status, "stopped", "status");
    eq(workers(), 0, "workers");
    eq((await a.call("echo", { value: 2 })).value, 2, "reloaded");
    eq(a.status, "ready", "status after");
  });

  await t("page hidden: the worker is stopped and the onHidden hook runs", async () => {
    let hook = 0;
    a.onHidden(() => hook++);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.visibilityState;
    eq(workers(), 0, "workers");
    eq(hook, 1, "hook");
    eq(a.status, "stopped", "status");
  });

  await t("dispose() rejects pending calls with disposed", async () => {
    const c = make();
    await c.load();
    const p = c.call("busy", { ms: 500 });
    c.dispose();
    await rejects(p, (e) => eq(e.code, "disposed", "code"));
    eq(c.status, "not-loaded", "status");
  });

  await t("idle timeout stops the worker", async () => {
    a.dispose();
    const d = make({ idleTimeout: 200 });
    await d.load();
    await d.call("echo", { value: 3 });
    await sleep(500);
    eq(workers(), 0, "workers");
    eq(d.status, "stopped", "status");
    d.dispose();
  });

  await t("files missing at filesUrl: load() rejects with download-failed, status error", async () => {
    const e = pool.handle({ name: "missing", filesUrl: "./no-such-folder/", createWorker });
    await rejects(e.load(), (err) => eq(err.code, "download-failed", "code"));
    eq(e.status, "error", "status");
  });

  await t("crash guard: simulating a crash during loading (the page reloads)...", async () => {
    sessionStorage.setItem("kakera-test:results", JSON.stringify(results));
    sessionStorage.setItem(`kakera-test:loading:${CRASH_KEY}`, String(Date.now()));
    location.replace(`${location.pathname}?phase=2`);
    await new Promise(() => {});
  });
}

async function phase2() {
  for (const r of JSON.parse(sessionStorage.getItem("kakera-test:results") ?? "[]")) {
    results.push(r);
    const li = document.createElement("li");
    li.innerHTML = `<span class="${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}</span> ${r.name}`;
    list.append(li);
  }
  sessionStorage.removeItem("kakera-test:results");

  await t("crash guard: after the crash, unavailable without loading", async () => {
    const a = make();
    eq(a.status, "unavailable", "status");
    await rejects(a.load(), (e) => eq(e.code, "unavailable", "code"));
    eq(workers(), 0, "nothing loaded");
  });

  await t("crash guard: resetCrashGuard() allows loading again (from the device)", async () => {
    const a = make();
    a.resetCrashGuard();
    eq(a.status, "not-loaded", "status");
    eq((await a.load()).fromCache, true, "from the device");
    a.dispose();
  });

  await t("crash guard off: crash records are ignored", async () => {
    localStorage.setItem(`kakera-test:crashed:${CRASH_KEY}`, String(Date.now()));
    const a = make({ crashGuard: false });
    eq(a.status, "not-loaded", "status");
    await a.load();
    a.dispose();
    make().resetCrashGuard();
  });
}

await (phase === "2" ? phase2() : phase1());
const failed = results.filter((r) => !r.ok).length;
const summary = document.getElementById("summary");
summary.textContent = failed ? `${failed} of ${results.length} failed` : `All ${results.length} passed`;
summary.className = failed ? "bad" : "ok";
window.__done = true;
