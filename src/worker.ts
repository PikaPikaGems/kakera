// Worker side of an engine: routes messages from host.js to the engine's functions and reports progress, "still
// working" signals and errors in the form the host expects.
//
//   serveEngine({
//     load: async (msg, ctx) => { await ctx.loadFiles({ onFile }); ...; return an object (or nothing) },
//     calls: { analyze: async (msg, ctx) => { ...; ctx.alive(); return result } },
//   });
//
// Messages in:  { id, type: "load", manifestUrl, dbName }  |  { id, type: <call name>, ...payload }
// Messages out: { id, type: "progress", loaded, total } (a call's own progress)
//               | { id, type: "progress", step, ...details } (loading: a file step, or an engine step from ctx.step)
//               | { id, type: "alive" } | { id, type: "log", msg }
//               | { id, type: "done", result } | { id, type: "error", code, message }
import { codedError, errorCode, errorFields } from "./errors.js";
import { fileStore } from "./files.js";

import type { FileLoadOptions, FileLoadResult } from "./files.js";
import type { FileProgress, WorkerRequest, WorkerResponse } from "./types.js";
export interface EngineContext {
  progress(loaded: number, total: number): void;
  alive(): void;
  step(step: string, details?: FileProgress): void;
  log(message: string): void;
  loadFiles(options: FileLoadOptions): Promise<FileLoadResult>;
}
export interface EngineDefinition {
  load(message: WorkerRequest, context: EngineContext): Promise<Record<string, unknown> | void>;
  calls: Record<string, (message: WorkerRequest, context: EngineContext) => Promise<unknown>>;
}
export interface TransferResult<T> { [TRANSFER]: true; value: T; transfer: Transferable[] }
type OutgoingMessage = WorkerResponse extends infer R ? R extends WorkerResponse ? Omit<R, "id"> : never : never;
// This module runs only in a dedicated worker; keep its globals separate from the page's DOM types.
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
};
function isTransferResult(value: unknown): value is TransferResult<unknown> {
  return typeof value === "object" && value !== null && TRANSFER in value;
}

const TRANSFER = Symbol("transfer");

/** Return this from a call to move (not copy) buffers to the page, e.g. audio samples. */
export const withTransfer = <T>(value: T, transfer: Transferable[]): TransferResult<T> => ({ [TRANSFER]: true, value, transfer });

/**
 * @param {object} engine
 * @param {(msg: object, ctx: object) => Promise<unknown>} engine.load
 * @param {Record<string, (msg: object, ctx: object) => Promise<unknown>>} engine.calls
 */
export function serveEngine({ load, calls }: EngineDefinition) {
  let ready = false;
  workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
    const { id, type } = data;
    const post = (msg: OutgoingMessage, transfer?: Transferable[]) => workerScope.postMessage({ id, ...msg }, transfer ?? []);
    let files: FileLoadResult | null = null; // what ctx.loadFiles() found: tells the page whether anything was downloaded
    const ctx: EngineContext = {
      progress: (loaded, total) => post({ type: "progress", loaded, total }),
      alive: () => post({ type: "alive" }),
      /** Report an engine step while loading, e.g. ctx.step("create-voice-model", { file: "model.onnx" }). */
      step: (step, details = {}) => post({ type: "progress", ...details, step, engine: true }),
      log: (msg) => post({ type: "log", msg }),
      /** Load the files of the manifest the host named, with progress and "still working" reported. */
      loadFiles: async (o) => (files = await fileStore({ dbName: data.dbName as string }).load(data.manifestUrl as string, {
        onProgress: (p) => post({ type: "progress", ...p }),
        log: ctx.log,
        ...o,
      })),
    };
    try {
      let result: unknown;
      if (type === "load") {
        const engine = await load(data, ctx);
        result = { fromCache: (files as FileLoadResult | null)?.fromCache ?? true, ...engine };
        ready = true;
      } else {
        if (!ready) throw codedError("not-loaded", "engine not loaded");
        const fn = calls[type];
        if (!fn) throw codedError("engine-failed", `unknown call "${type}"`);
        result = await fn(data, ctx);
      }
      if (isTransferResult(result)) post({ type: "done", result: result.value }, result.transfer);
      else post({ type: "done", result });
    } catch (err) {
      post({ type: "error", code: errorCode(err), message: String(errorFields(err).message ?? err) });
    }
  };
}
