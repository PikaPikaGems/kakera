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
import { codedError, errorCode } from "./errors.js";
import { fileStore } from "./files.js";

const TRANSFER = Symbol("transfer");

/** Return this from a call to move (not copy) buffers to the page, e.g. audio samples. */
export const withTransfer = (value, transfer) => ({ [TRANSFER]: true, value, transfer });

/**
 * @param {object} engine
 * @param {(msg: object, ctx: object) => Promise<unknown>} engine.load
 * @param {Record<string, (msg: object, ctx: object) => Promise<unknown>>} engine.calls
 */
export function serveEngine({ load, calls }) {
  let ready = false;
  self.onmessage = async ({ data }) => {
    const { id, type } = data;
    const post = (msg, transfer) => self.postMessage({ id, ...msg }, transfer ?? []);
    let files = null; // what ctx.loadFiles() found: tells the page whether anything was downloaded
    const ctx = {
      progress: (loaded, total) => post({ type: "progress", loaded, total }),
      alive: () => post({ type: "alive" }),
      /** Report an engine step while loading, e.g. ctx.step("create-voice-model", { file: "model.onnx" }). */
      step: (step, details = {}) => post({ type: "progress", ...details, step, engine: true }),
      log: (msg) => post({ type: "log", msg }),
      /** Load the files of the manifest the host named, with progress and "still working" reported. */
      loadFiles: async (o) => (files = await fileStore({ dbName: data.dbName }).load(data.manifestUrl, {
        onProgress: (p) => post({ type: "progress", ...p }),
        log: ctx.log,
        ...o,
      })),
    };
    try {
      let result;
      if (type === "load") {
        const engine = await load(data, ctx);
        result = { fromCache: files?.fromCache ?? true, ...engine };
        ready = true;
      } else {
        if (!ready) throw codedError("not-loaded", "engine not loaded");
        const fn = calls[type];
        if (!fn) throw codedError("engine-failed", `unknown call "${type}"`);
        result = await fn(data, ctx);
      }
      if (result?.[TRANSFER]) post({ type: "done", result: result.value }, result.transfer);
      else post({ type: "done", result });
    } catch (err) {
      post({ type: "error", code: errorCode(err), message: err?.message ?? String(err) });
    }
  };
}
