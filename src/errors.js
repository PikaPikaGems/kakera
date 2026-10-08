// Errors with a `code`, shared by every package built on kakera. Each package exposes its own subclass name
// (`class VoiceError extends KakeraError {}`) and hands it to the pool, so its users see one error type.
//
// Codes:
//   not-loaded           a call before load()
//   disposed             the handle was disposed while the call was pending
//   unavailable          load(): loading crashed this tab recently (crash guard)
//   unsupported-browser  no WebAssembly / Web Workers / IndexedDB / DecompressionStream
//   download-failed      network or HTTP error (includes files missing at the files URL)
//   checksum-mismatch    a downloaded part was corrupt
//   out-of-memory        the browser refused the memory
//   timeout              no progress for too long; the worker was stopped
//   engine-failed        the engine failed in an unexpected way
//   worker-crashed       the worker died after loading

export class KakeraError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A plain Error with a code, for code that runs in workers (the code survives postMessage as data). */
export const codedError = (code, message) => Object.assign(new Error(message), { code });

/** Best guess at a code for an error thrown inside an engine. */
export function errorCode(err) {
  if (err?.code) return err.code;
  const msg = String(err?.message ?? err);
  if (err instanceof RangeError || /out of memory|allocation/i.test(msg)) return "out-of-memory";
  return "engine-failed";
}
