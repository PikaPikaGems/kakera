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
  readonly code: string;
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A plain Error with a code, for code that runs in workers (the code survives postMessage as data). */
export const codedError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Best guess at a code for an error thrown inside an engine. */
export function errorCode(err: unknown): string {
  const details = errorFields(err);
  if (typeof details.code === "string" && details.code) return details.code;
  const msg = String(details.message ?? err);
  if (err instanceof RangeError || /out of memory|allocation/i.test(msg)) return "out-of-memory";
  return "engine-failed";
}

/** Read fields at an error boundary without assuming that thrown values are Error instances. */
export function errorFields(value: unknown): { code?: unknown; message?: unknown; name?: unknown; cause?: unknown } {
  return value != null && (typeof value === "object" || typeof value === "function") ? value : {};
}
