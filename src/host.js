// Page side of an engine: one Web Worker per engine for the whole page, shared by every handle, with the
// protections phones need. Ported from jp-tts-playground's jp-analyzer, where it was tested in the browser.
//
//   const pool = createPool({ prefix: "yomiage", ErrorClass: VoiceError });
//   const h = pool.handle({ name: "tsukuyomi", filesUrl, createWorker, ...options });
//   await h.load();
//   const result = await h.call("speak", { text }, { stall: 20_000, signal });
//
// Structure:
//   EngineHost  one per engine (name + manifest URL) per page: the worker, the watchdog, the idle timer, the
//               crash-guard marker. Shared by every handle of that engine.
//   Handle      cheap, one per user of the engine: its options, listeners and pending calls. Packages wrap it.
//
// What it guarantees:
//   - loading starts only when load() is called; calls before that reject with "not-loaded"
//   - crash guard: iOS kills a tab that uses too much memory and reloads it, without any code running. A marker is
//     written to sessionStorage (per tab, survives that reload) before loading and removed when loading ends or the
//     page is left normally (pagehide). A marker found when the pool starts means the last load crashed the tab:
//     that is recorded in localStorage, and load() rejects with "unavailable" for retryAfterDays
//   - timeouts measure time WITHOUT PROGRESS (any message from the worker counts), so slow-but-working never fails
//   - the worker stops after idleTimeout without calls, and when the page is hidden; the next call reloads it
//   - cancelling with AbortSignal; dispose() drops a handle's calls from the worker too
import { KakeraError } from "./errors.js";
import { fileStore } from "./files.js";

export const DEFAULTS = Object.freeze({
  filesUrl: null, // required from the package (e.g. "/yomiage/")
  idleTimeout: 60_000,
  stopWhenHidden: true,
  crashGuard: { retryAfterDays: 7 },
  loadStall: 60_000,
  persistStorage: true,
});

const safely = (fn) => { try { return fn(); } catch { return undefined; } };
const storageOf = (kind) => safely(() => (kind === "session" ? sessionStorage : localStorage));
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/**
 * Turns the worker's loading steps into what apps show (a stage and one fraction for the whole load, never going
 * backwards) and what helps debugging (every step, with how long it took).
 *
 * Fraction:
 *   - downloading: bytes downloaded count for 75%, bytes unpacked for 20%; engine steps after the last file move the
 *     bar closer to 99%
 *   - from the device, first time: bytes unpacked count for 90%, then the same
 *   - from the device, with `profile` (how long each step took in the last load from the device on this device): by
 *     time, so the bar keeps moving through long steps that report nothing (tick() is called every 200 ms)
 * "ready" is 100%.
 * @param {{ total: number, steps: Record<string, number> } | null} profile
 */
function loadTracker(profile) {
  const t0 = performance.now();
  const timings = [];
  let files = {}, fraction = 0, filesDone = false, current = null, last = null, doneMs = 0;
  const elapsed = (now) => Math.round(now - t0);
  const byTime = () => !!profile && files.toUnpack > 0 && !files.toDownload;

  function compute(now) {
    const { downloaded = 0, toDownload = 0, unpacked = 0, toUnpack = 0 } = files;
    let f;
    if (byTime()) {
      const inStep = current ? Math.min(now - current.start, profile.steps[current.key] ?? 0) : 0;
      f = (doneMs + inStep) / profile.total;
    } else {
      const u = toUnpack ? unpacked / toUnpack : 0;
      f = toDownload > 0 ? 0.75 * Math.min(1, downloaded / toDownload) + 0.2 * u : 0.9 * u;
    }
    fraction = Math.min(0.99, Math.max(fraction, f));
  }

  function event(now) {
    const { downloaded = 0, toDownload = 0, unpacked = 0, toUnpack = 0 } = files;
    const downloading = toDownload > 0 && downloaded < toDownload;
    const { engine, type, id, ...details } = last;
    return {
      ...details,
      stage: downloading ? "downloading" : "preparing",
      fraction,
      loaded: downloading ? downloaded : unpacked,
      total: downloading ? toDownload : toUnpack,
      ms: elapsed(now),
    };
  }

  return {
    /** @returns {{ event: object, newStep: boolean }} */
    update(p) {
      const now = performance.now();
      last = p;
      if (!p.engine) files = p;
      if (p.step === "file-done" && p.fileIndex === p.files) filesDone = true;
      const key = `${p.step}|${p.file ?? ""}|${p.part ?? ""}`;
      const newStep = current?.key !== key;
      if (newStep) {
        if (current) {
          current.ms = Math.round(now - current.start);
          doneMs += profile?.steps[current.key] ?? 0;
        }
        current = { key, start: now, step: p.step, ...(p.file && { file: p.file }), ...(p.part && { part: p.part }), at: elapsed(now) };
        timings.push(current);
      }
      compute(now);
      if (!byTime() && filesDone && p.engine && newStep) fraction = Math.min(0.99, fraction + (0.99 - fraction) / 3);
      return { newStep, event: event(now) };
    },
    /** While a step runs: a new event when the time-based bar has moved, else null. */
    tick() {
      if (!last || !byTime()) return null;
      const before = fraction;
      compute(performance.now());
      return fraction - before >= 0.005 ? event(performance.now()) : null;
    },
    /** Every step with its duration, and the whole load's. */
    finish() {
      const now = performance.now();
      if (current) current.ms = Math.round(now - current.start);
      const steps = {};
      for (const t of timings) steps[t.key] = (steps[t.key] ?? 0) + t.ms;
      return {
        ms: elapsed(now),
        timings: timings.map(({ key, start, ...t }) => t),
        profile: { total: Math.max(1, timings.reduce((n, t) => n + t.ms, 0)), steps },
      };
    },
  };
}

function unsupported() {
  if (typeof WebAssembly !== "object") return "WebAssembly";
  if (typeof Worker !== "function") return "Web Workers";
  if (typeof indexedDB !== "object") return "IndexedDB";
  if (typeof DecompressionStream !== "function") return "DecompressionStream (Safari 16.4+)";
  return null;
}

/**
 * @param {{ prefix: string, ErrorClass?: typeof KakeraError }} o
 *   prefix: the package's name; used for storage keys and the IndexedDB database
 */
export function createPool({ prefix, ErrorClass = KakeraError }) {
  const LOADING = `${prefix}:loading:`, CRASHED = `${prefix}:crashed:`, PROFILE = `${prefix}:timings:`;

  // A marker left over from the previous page in this tab = that load crashed the tab.
  safely(() => {
    const s = storageOf("session"), l = storageOf("local");
    for (const k of Object.keys(s)) {
      if (!k.startsWith(LOADING)) continue;
      l?.setItem(CRASHED + k.slice(LOADING.length), String(Date.now()));
      s.removeItem(k);
    }
  });
  const markLoading = (key) => safely(() => storageOf("session").setItem(LOADING + key, String(Date.now())));
  const clearLoading = (key) => safely(() => storageOf("session").removeItem(LOADING + key));
  const crashedAt = (key) => Number(safely(() => storageOf("local").getItem(CRASHED + key)) ?? 0);
  const forgetCrash = (key) => safely(() => storageOf("local").removeItem(CRASHED + key));

  const hosts = new Map();
  const handlesWithHiddenHook = new Set(); // handles that registered onHidden()

  class EngineHost {
    constructor({ name, manifestUrl, createWorker }) {
      this.name = name;
      this.url = manifestUrl;
      this.key = `${name}|${manifestUrl}`;
      this.createWorker = createWorker;
      this.status = "not-loaded"; // not-loaded | downloading | loading | ready | stopped
      this.worker = null;
      this.loading = null;
      this.pending = new Map(); // id -> { resolve, reject, onProgress, stall, timer, cleanup }
      this.nextId = 1;
      this.users = new Set();
      this.idleTimer = null;
      this.stopWhenDone = false; // the page went hidden during a call: stop once nothing is pending
    }

    active() { return [...this.users].filter((h) => h._active); }

    setStatus(status) {
      if (status === this.status) return;
      this.status = status;
      for (const h of this.users) h._emitStatus();
    }

    // ---- policy, combined over the handles using this engine
    idleMs() {
      const v = this.active().map((h) => h._opts.idleTimeout);
      return v.length === 0 || v.includes(0) ? 0 : Math.max(...v);
    }
    stopsWhenHidden() { const a = this.active(); return a.length > 0 && a.every((h) => h._opts.stopWhenHidden); }
    loadStallMs() { return Math.max(...this.active().map((h) => h._opts.loadStall), 1); }

    /** Start the worker and load the engine. Shared: concurrent callers get the same promise. */
    load() {
      if (this.status === "ready") return Promise.resolve({ fromCache: true });
      this.loading ??= (async () => {
        markLoading(this.key);
        this.worker = this.createWorker();
        this.worker.onmessage = ({ data }) => this.onMessage(data);
        this.worker.onerror = (e) => {
          e.preventDefault?.();
          const loading = this.status !== "ready";
          this.kill(new ErrorClass(loading ? "engine-failed" : "worker-crashed",
            `${this.name} worker ${loading ? "failed to start" : "crashed"}: ${e.message || "unknown error"}`));
        };
        this.setStatus("loading");
        const profileKey = `${PROFILE}${this.key}`;
        const tracker = loadTracker(safely(() => JSON.parse(storageOf("local").getItem(profileKey))) ?? null);
        const emit = (event, value) => { for (const h of this.active()) h._emit(event, value); };
        const ticker = setInterval(() => { const e = tracker.tick(); if (e) emit("progress", e); }, 200);
        try {
          const result = await this.call({ type: "load", manifestUrl: this.url, dbName: prefix }, {
            stall: this.loadStallMs(),
            onProgress: (p) => {
              if (!p.step) return;
              const { event, newStep } = tracker.update(p);
              if (newStep) {
                const where = event.file ? ` ${event.file}${event.parts > 1 ? ` part ${event.part}/${event.parts}` : ""}` : "";
                emit("log", `${(event.ms / 1000).toFixed(2)} s  ${event.step}${where}`);
              }
              // until the manifest is read it isn't known whether anything must be downloaded: timed and logged only
              if (p.step === "manifest") return;
              this.setStatus(event.stage === "downloading" ? "downloading" : "loading");
              emit("progress", event);
            },
          });
          clearInterval(ticker);
          const { ms, timings, profile } = tracker.finish();
          // how long each step takes on this device, for a bar that moves by time next time (loads from the device only)
          if (result?.fromCache !== false) safely(() => storageOf("local").setItem(profileKey, JSON.stringify(profile)));
          this.setStatus("ready");
          emit("progress", { stage: "ready", step: "ready", fraction: 1, ms });
          emit("log", `${(ms / 1000).toFixed(2)} s  ready`);
          this.touch();
          return { fromCache: true, ...result, ms, timings };
        } catch (err) {
          if (this.worker) this.kill(err, "not-loaded");
          throw err;
        } finally {
          clearInterval(ticker);
          clearLoading(this.key);
          this.loading = null;
        }
      })();
      return this.loading;
    }

    /** Send a message; resolves with the worker's result. `stall` = ms without any message before giving up. */
    call(msg, { stall, signal, onProgress } = {}) {
      if (!this.worker) return Promise.reject(new ErrorClass("not-loaded", `${this.name} is not loaded`));
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const entry = { resolve, reject, onProgress, stall, timer: null };
        const onAbort = () => { this.settle(id); reject(abortError()); };
        entry.cleanup = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.pending.set(id, entry);
        this.armWatchdog(id);
        this.worker.postMessage({ id, ...msg });
      });
    }

    armWatchdog(id) {
      const e = this.pending.get(id);
      if (!e?.stall) return;
      clearTimeout(e.timer);
      e.timer = setTimeout(() => {
        this.kill(new ErrorClass("timeout", `${this.name} stopped responding (no progress for ${Math.round(e.stall / 1000)} s); it was stopped to free memory`));
      }, e.stall);
    }

    /** Remove a pending call (finished, failed or aborted). */
    settle(id) {
      const e = this.pending.get(id);
      if (!e) return null;
      clearTimeout(e.timer);
      e.cleanup?.();
      this.pending.delete(id);
      if (this.pending.size === 0 && this.stopWhenDone) { this.stopWhenDone = false; queueMicrotask(() => this.unload()); }
      return e;
    }

    onMessage(data) {
      const e = this.pending.get(data.id);
      if (!e) return; // aborted or killed
      if (data.type === "done" || data.type === "error") {
        this.settle(data.id);
        if (data.type === "done") e.resolve(data.result);
        else e.reject(new ErrorClass(data.code ?? "engine-failed", data.message));
        return;
      }
      // progress, alive and log all mean "still working"; calls queued behind this one wait on the same worker,
      // so their watchdogs are reset too
      for (const id of this.pending.keys()) this.armWatchdog(id);
      if (data.type === "progress") e.onProgress?.(data);
      if (data.type === "log") for (const h of this.users) h._emit("log", data.msg);
    }

    /** Terminate the worker and reject everything pending with `err`. */
    kill(err, status = "stopped") {
      this.worker?.terminate();
      this.worker = null;
      clearTimeout(this.idleTimer);
      clearLoading(this.key);
      for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
      this.stopWhenDone = false;
      this.setStatus(this.status === "ready" || this.status === "stopped" ? status : "not-loaded");
    }

    /** Free the memory. The next call of a handle that loaded it reloads from the device. */
    unload() {
      if (!this.worker) return;
      this.kill(new ErrorClass("disposed", `${this.name} was unloaded`), "stopped");
    }

    /** Unload if no handle wants the engine any more. */
    release() { if (this.active().length === 0) this.unload(); }

    /** Restart the idle countdown. */
    touch() {
      clearTimeout(this.idleTimer);
      const ms = this.idleMs();
      if (ms > 0 && this.status === "ready") {
        this.idleTimer = setTimeout(() => (this.pending.size ? this.touch() : this.unload()), ms);
      }
    }

    onHidden() {
      if (this.status !== "ready" || !this.stopsWhenHidden()) return;
      if (this.pending.size) this.stopWhenDone = true;
      else this.unload();
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        for (const h of hosts.values()) h.onHidden();
        for (const h of handlesWithHiddenHook) safely(() => h._onHidden());
      }
    });
    // Leaving the page normally (close, navigate, reload) is not a crash.
    addEventListener("pagehide", () => { for (const h of hosts.values()) if (h.loading) clearLoading(h.key); });
    addEventListener("pageshow", (e) => { if (e.persisted) for (const h of hosts.values()) if (h.loading) markLoading(h.key); });
  }
  class Handle {
    constructor(options) {
      const o = { ...DEFAULTS, ...options };
      if (!o.name || !o.filesUrl || typeof o.createWorker !== "function") throw new TypeError("handle(): name, filesUrl and createWorker are required");
      o.crashGuard = o.crashGuard === false ? false : { ...DEFAULTS.crashGuard, ...o.crashGuard };
      this._opts = o;
      const manifestUrl = new URL("manifest.json", new URL(o.filesUrl.endsWith("/") ? o.filesUrl : `${o.filesUrl}/`, location.href)).href;
      const key = `${o.name}|${manifestUrl}`;
      if (!hosts.has(key)) hosts.set(key, new EngineHost({ name: o.name, manifestUrl, createWorker: o.createWorker }));
      this._host = hosts.get(key);
      this._active = false; // wants the engine loaded (true after load(), false after unload()/dispose())
      this._loaded = false; // load() has succeeded at least once (calls may reload by themselves)
      this._own = this._crashed() ? "unavailable" : "not-loaded"; // status when not attached
      this._loadPromise = null;
      this._calls = new Set();
      this._disposeCtrl = new AbortController();
      this._listeners = new Map();
      this._lastStatus = this.status;
      this._files = fileStore({ dbName: prefix });
    }

    get status() {
      // attached: the engine's own status (downloading, loading, ready, ...); detached: stopped once it has loaded
      if (this._active) return this._host.status === "not-loaded" ? (this._loaded ? "stopped" : "loading") : this._host.status;
      return this._loaded ? "stopped" : this._own;
    }

    /** Subscribe to "status", "progress" or "log". Returns an unsubscribe function. */
    on(event, listener) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      const set = this._listeners.get(event);
      set.add(listener);
      return () => set.delete(listener);
    }
    _emit(event, value) { for (const fn of this._listeners.get(event) ?? []) safely(() => fn(value)); }
    _emitStatus() {
      const s = this.status;
      if (s === this._lastStatus) return;
      this._lastStatus = s;
      this._emit("status", s);
    }

    /** Called when the page is hidden (for packages that also stop playback then). */
    onHidden(fn) { this._onHidden = fn; handlesWithHiddenHook.add(this); }

    _crashed() {
      const g = this._opts.crashGuard;
      if (!g) return false;
      const t = crashedAt(this._host.key);
      return t > 0 && Date.now() - t < g.retryAfterDays * 86_400_000;
    }

    _attach() {
      this._active = true;
      this._host.users.add(this);
      this._emitStatus();
    }

    async info() {
      const { cached, downloadBytes } = await this._files.info(this._host.url);
      return { cached, downloadBytes, downloadMB: Math.round(downloadBytes / 1e6) };
    }

    load() {
      if (this._loaded && this._active && this._host.status === "ready") return Promise.resolve({ fromCache: true });
      this._loadPromise ??= this._load().finally(() => { this._loadPromise = null; });
      return this._loadPromise;
    }

    async _load() {
      const missing = unsupported();
      if (missing) { this._fail("error"); throw new ErrorClass("unsupported-browser", `this browser lacks ${missing}`); }
      if (this._crashed()) {
        this._fail("unavailable");
        throw new ErrorClass("unavailable", `loading ${this._opts.name} crashed this tab recently; not loading it again yet (resetCrashGuard() to retry)`);
      }
      this._attach();
      try {
        const res = await this._host.load();
        this._loaded = true;
        this._emitStatus();
        if (!res.fromCache && this._opts.persistStorage) navigator.storage?.persist?.()?.catch?.(() => {});
        return { fromCache: !!res.fromCache, ...(res.timings && { ms: res.ms, timings: res.timings }) };
      } catch (err) {
        this._active = false;
        this._host.users.delete(this);
        this._host.release();
        this._fail("error");
        throw err;
      }
    }
    _fail(status) { this._own = status; this._emitStatus(); }

    /**
     * Run a call in the worker. Reloads the engine first if it was unloaded (idle, hidden, unload()).
     * @param {string} type
     * @param {object} payload
     * @param {{ stall?: number, signal?: AbortSignal }} [o]
     */
    call(type, payload = {}, { stall, signal } = {}) {
      if (!this._loaded) return Promise.reject(new ErrorClass("not-loaded", "call load() first"));
      // one signal for "the caller aborted" or "this handle was disposed"
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      const disposed = this._disposeCtrl.signal;
      signal?.addEventListener("abort", abort, { once: true });
      disposed.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) ctrl.abort();
      return new Promise((resolve, reject) => {
        const entry = reject;
        this._calls.add(entry);
        (async () => {
          if (!this._active) this._attach();
          if (this._host.status !== "ready") await this._host.load();
          if (ctrl.signal.aborted) throw abortError();
          const result = await this._host.call({ type, ...payload }, { stall, signal: ctrl.signal });
          this._host.touch();
          return result;
        })().then(resolve, reject).finally(() => {
          this._calls.delete(entry);
          signal?.removeEventListener("abort", abort);
          disposed.removeEventListener("abort", abort);
        });
      });
    }

    /** Free the memory now, if no other handle needs the engine. The next call reloads it from the device. */
    unload() {
      if (!this._active) return;
      this._active = false;
      this._host.release();
      this._emitStatus();
    }

    /** Back to "not-loaded": pending calls reject with "disposed"; load() is needed again. */
    dispose() {
      const err = new ErrorClass("disposed", "disposed");
      for (const reject of [...this._calls]) reject(err);
      this._calls.clear();
      this._disposeCtrl.abort(); // drop those calls from the worker too, so it isn't kept busy for nobody
      this._disposeCtrl = new AbortController();
      this._active = false;
      this._loaded = false;
      this._host.users.delete(this);
      this._host.release();
      handlesWithHiddenHook.delete(this);
      this._own = "not-loaded";
      this._emitStatus();
    }

    /** Delete the engine's files from this device. */
    async clearCache() { await this._files.clear(this._host.url); }

    /** Forget a recorded crash so the next load() tries again. */
    resetCrashGuard() {
      forgetCrash(this._host.key);
      if (this._own === "unavailable") this._fail("not-loaded");
    }
  }

  return {
    handle: (options) => new Handle(options),
    /** For tests: the page's engines. */
    engines: () => [...hosts.values()].map((h) => ({ name: h.name, status: h.status, worker: !!h.worker, users: h.users.size })),
  };
}
