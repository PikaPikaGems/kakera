// Programs with big built-in data (a dictionary compiled into a wasm file as data segments): ship the data as its own
// file and write it into the program's memory ourselves.
//
// Why: browsers keep a copy of every data segment inside the compiled module for as long as the program lives, on
// top of the copy in its memory. For a 60–120 MB dictionary that is a second 60–120 MB. Without the data section the
// compiled program is small, and the data exists once, in memory.
//
// Build side: splitWasm(wasm) → { code, segments }; ship `code` as the program and the segments' bytes, one after the
// other, as a data file, with the segment table ({ offset, length }[]) in the manifest's meta.
// Worker side: segmentWriter(memory, table) writes that data file's chunks into memory as they stream in, or
// initWithData() does it for a wasm-bindgen program whose start code needs the data.
import { codedError } from "./errors.js";

import type { ByteChunks } from "./types.js";
export interface DataSegment { offset: number; length: number }

const SECTION = { start: 8, data: 11, dataCount: 12 };

function leb(buf: Uint8Array, i: number): [number, number] {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, i];
}

/**
 * Split a wasm binary into its program and its data segments. Only safe when nothing runs during instantiation (no
 * start section) and no code uses memory.init / data.drop (which would read the removed segments). Both are checked:
 * the start section directly; for memory.init, the DataCount section (which recent Rust always emits) is removed too,
 * and WebAssembly validation rejects any program that uses memory.init or data.drop without one.
 * @param {Uint8Array} wasm
 * @returns {{ code: Uint8Array, segments: { offset: number, bytes: Uint8Array }[] }}
 */
export function splitWasm(wasm: Uint8Array) {
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) throw new Error("not a wasm file");
  const kept = [wasm.subarray(0, 8)];
  const segments = [];
  let i = 8;
  while (i < wasm.length) {
    const id = wasm[i];
    const [size, bodyStart] = leb(wasm, i + 1);
    const end = bodyStart + size;
    if (id === SECTION.start) throw new Error("wasm has a start function; its data cannot be moved out safely");
    if (id === SECTION.dataCount) { i = end; continue; } // dropped; see the validation below
    if (id === SECTION.data) {
      let [count, j] = leb(wasm, bodyStart);
      while (count--) {
        let flags, offset, len;
        [flags, j] = leb(wasm, j);
        // flags 0 = active segment in memory 0 with a constant offset expression: i32.const <n> end
        if (flags !== 0 || wasm[j] !== 0x41) throw new Error(`unsupported data segment (flags ${flags})`);
        [offset, j] = leb(wasm, j + 1);
        if (wasm[j] !== 0x0b) throw new Error("unsupported data segment offset expression");
        [len, j] = leb(wasm, j + 1);
        segments.push({ offset, bytes: wasm.subarray(j, j + len) });
        j += len;
      }
    } else {
      kept.push(wasm.subarray(i, end));
    }
    i = end;
  }
  const code = new Uint8Array(kept.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const k of kept) { code.set(k, o); o += k.length; }
  if (!WebAssembly.validate(code)) throw new Error("the program does not validate without its data segments (it uses memory.init or data.drop); it cannot be split");
  return { code, segments };
}

/**
 * Writes a stream of bytes across the data segments, in order. Call it with each chunk, then `.finish()`, which
 * checks that every segment was filled.
 * @param {WebAssembly.Memory} memory
 * @param {{ offset: number, length: number }[]} segments
 */
export function segmentWriter(memory: WebAssembly.Memory, segments: DataSegment[]) {
  const end = Math.max(0, ...segments.map((s) => s.offset + s.length));
  if (memory.buffer.byteLength < end) memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  let seg = 0, pos = 0;
  while (segments[seg]?.length === 0) seg++;
  const write = (chunk: Uint8Array) => {
    let c = 0;
    while (c < chunk.length) {
      const s = segments[seg];
      if (!s) throw codedError("checksum-mismatch", "the data file is longer than its segment table");
      const n = Math.min(s.length - pos, chunk.length - c);
      new Uint8Array(memory.buffer, s.offset + pos, n).set(chunk.subarray(c, c + n));
      pos += n; c += n;
      if (pos === s.length) { seg++; pos = 0; while (segments[seg]?.length === 0) seg++; }
    }
  };
  write.finish = () => {
    if (seg < segments.length) throw codedError("checksum-mismatch", "the data file is shorter than its segment table");
  };
  return write;
}

/**
 * Start a wasm-bindgen program from its split files: `init` is the glue's default export, `code` the program without
 * its data, `chunks` the data file. The data is written into the program's memory right after it is created and
 * before its start code (`__wbindgen_start`) runs, by wrapping WebAssembly.instantiate for the duration of the call.
 * Only the instantiation of this program is touched: other code may instantiate other programs meanwhile.
 * @returns whatever `init` returns
 */
export async function initWithData<T>(init: (options: { module_or_path: WebAssembly.Module }) => T | Promise<T>, code: BufferSource | WebAssembly.Module, segments: DataSegment[], chunks: ByteChunks): Promise<T> {
  const module = code instanceof WebAssembly.Module ? code : await WebAssembly.compile(code);
  const real = WebAssembly.instantiate;
  let written = false;
  const instantiate = async (source: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) => {
    const result = source instanceof WebAssembly.Module ? await real(source, imports) : await real(source, imports);
    if (source !== module) return result;
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw codedError("engine-failed", "the program does not export its memory");
    const write = segmentWriter(memory, segments);
    for await (const chunk of chunks) write(chunk);
    write.finish();
    written = true;
    return result;
  };
  // The wrapper preserves both native overloads: modules yield an Instance, bytes yield an instantiated source.
  WebAssembly.instantiate = instantiate as typeof WebAssembly.instantiate;
  try {
    const out = await init({ module_or_path: module });
    if (!written) throw codedError("engine-failed", "the program started without its data (the glue did not call WebAssembly.instantiate)");
    return out;
  } finally {
    WebAssembly.instantiate = real;
  }
}
