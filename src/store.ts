// Engine state for UI code: one object that changes as the engine loads, for React's useSyncExternalStore (the
// packages' React hooks) or anything else with subscribe/getSnapshot. Framework-free: no React import here.
//
// It wraps an analyzer or a voice (anything shaped like StoreEngine) and adds what a settings page shows but the
// engine doesn't keep: whether the files are on the device, the download size, the latest progress and the last
// load error. Nothing here loads by itself: subscribing only reads the small manifest (info()), load() does the rest.

/** What engineStore() needs: the public shape shared by wakachi's analyzer and yomiage's voice. */
export interface StoreEngine<S extends string, P> {
  readonly status: S;
  on(event: "status", listener: (status: S) => void): () => void;
  on(event: "progress", listener: (progress: P) => void): () => void;
  info(): Promise<{ cached: boolean; downloadMB: number }>;
  load(): Promise<unknown>;
  unload(): void;
  clearCache(): Promise<void>;
  debugReport(): Promise<string>;
}

/** A snapshot of the engine. A new object each time something changes, so it can be compared with ===. */
export interface EngineSnapshot<S extends string, P> {
  status: S;
  /** The files are on this device. null until info() answered (a moment after the first subscribe). */
  cached: boolean | null;
  /** Download size in MB when not cached. null until info() answered. */
  downloadMB: number | null;
  /** The latest progress while downloading or loading, otherwise null. */
  progress: P | null;
  /** The last load() error, until the next load() starts or the engine is ready. */
  error: Error | null;
}

export interface EngineStore<S extends string, P> {
  /** Called on every change. Returns an unsubscribe function. The first subscriber triggers info(). */
  subscribe(listener: () => void): () => void;
  getSnapshot(): EngineSnapshot<S, P>;
  /** Download if needed, then load into memory. Never rejects: a failure goes to `error` (and `status`). */
  load(): Promise<void>;
  /** Free the memory, keep the files. */
  unload(): void;
  /** Delete the files from this device. */
  clearCache(): Promise<void>;
  debugReport(): Promise<string>;
  /** Read `cached` / `downloadMB` again. */
  refreshInfo(): Promise<void>;
}

const LOADING = new Set(["downloading", "loading"]);

export function engineStore<S extends string, P>(engine: StoreEngine<S, P>): EngineStore<S, P> {
  let snap: EngineSnapshot<S, P> = { status: engine.status, cached: null, downloadMB: null, progress: null, error: null };
  const listeners = new Set<() => void>();
  let infoAsked = false;
  let infoSeq = 0;

  function set(changes: Partial<EngineSnapshot<S, P>>) {
    const next = { ...snap, ...changes };
    if (!LOADING.has(next.status)) next.progress = null;
    if (next.status === "ready") next.error = null;
    if ((Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === snap[k])) return;
    snap = next;
    for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } }
  }

  engine.on("status", (status) => set({ status }));
  engine.on("progress", (progress) => { if (LOADING.has(engine.status)) set({ progress }); });

  async function refreshInfo() {
    const seq = ++infoSeq;
    try {
      const { cached, downloadMB } = await engine.info();
      if (seq === infoSeq) set({ cached, downloadMB });
    } catch { /* the manifest is unreachable: load() will say why */ }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!infoAsked) { infoAsked = true; void refreshInfo(); }
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snap,
    async load() {
      set({ error: null });
      try {
        await engine.load();
      } catch (err) {
        // "disposed": the files were deleted (clearCache()) during the load; not a failure to show
        const disposed = (err as { code?: unknown } | null)?.code === "disposed";
        set({ status: engine.status, error: disposed ? null : err instanceof Error ? err : new Error(String(err)) });
      }
      await refreshInfo();
    },
    unload: () => engine.unload(),
    async clearCache() {
      await engine.clearCache();
      await refreshInfo();
    },
    debugReport: () => engine.debugReport(),
    refreshInfo,
  };
}
