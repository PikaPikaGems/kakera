/** The engine states shared by packages built on kakera. */
export type EngineStatus = "not-loaded" | "downloading" | "loading" | "ready" | "stopped" | "unavailable" | "error";
export interface FilePart { file: string; size: number; rawSize: number; sha256: string }
export interface ManifestFile { name: string; size: number; gzip: boolean; parts: FilePart[] }
export interface Manifest { format: string; name: string; version: string; downloadSize: number; files: ManifestFile[]; meta?: Record<string, unknown> }
export type ByteChunks = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
export interface FileProgress {
  step?: string; file?: string | null; fileIndex?: number; files?: number; part?: number; parts?: number;
  downloaded?: number; toDownload?: number; unpacked?: number; toUnpack?: number;
  loaded?: number; total?: number; engine?: boolean;
}
export interface LoadProgress extends FileProgress { step: string; stage: "downloading" | "preparing" | "ready"; fraction: number; ms: number }
export interface LoadTiming { step: string; file?: string; part?: number; at: number; ms: number }
export interface LoadResult { fromCache: boolean; ms?: number; timings?: LoadTiming[] }
export interface EngineEvents { status: EngineStatus; progress: LoadProgress; log: string }
export interface CallOptions { stall?: number; signal?: AbortSignal }
/** Worker messages are the serialization boundary; call results remain unknown until the caller types them. */
export type WorkerResponse =
  | ({ id: number; type: "progress" } & FileProgress)
  | { id: number; type: "alive" }
  | { id: number; type: "log"; msg: string }
  | { id: number; type: "done"; result: unknown }
  | { id: number; type: "error"; code?: string; message: string };
export interface WorkerRequest { id: number; type: string; [key: string]: unknown }
export interface HandleOptions {
  name: string; filesUrl: string; workerUrl?: string; createWorker?: () => Worker; missingHint?: string;
  idleTimeout?: number; stopWhenHidden?: boolean; crashGuard?: false | { retryAfterDays?: number };
  loadStall?: number; persistStorage?: boolean;
}
export interface EngineHandle {
  readonly status: EngineStatus;
  on<E extends keyof EngineEvents>(event: E, listener: (value: EngineEvents[E]) => void): () => void;
  onHidden(fn: () => void): void;
  info(): Promise<{ cached: boolean; downloadBytes: number; downloadMB: number }>;
  debugReport(options?: { packageName?: string; packageVersion?: string }): Promise<string>;
  load(): Promise<LoadResult>;
  call<T = unknown>(type: string, payload?: Record<string, unknown>, options?: CallOptions): Promise<T>;
  unload(): void; dispose(): void; clearCache(): Promise<void>; resetCrashGuard(): void;
}
