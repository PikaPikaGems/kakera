import assert from "node:assert/strict";
import { test } from "node:test";
import { initWithData, segmentWriter, splitWasm } from "../src/wasm.js";

// A tiny program: one memory page (exported as "memory"), two data segments ("abc" at 16, "xy" at 100), and a
// `read(i)` function returning the byte at i.
const section = (id, bytes) => [id, bytes.length, ...bytes];
const str = (s) => [s.length, ...Buffer.from(s)];
const WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),                                   // type: (i32) -> i32
  ...section(3, [1, 0]),                                                         // function 0 has type 0
  ...section(5, [1, 0x00, 1]),                                                   // memory: min 1 page
  ...section(7, [2, ...str("memory"), 0x02, 0, ...str("read"), 0x00, 0]),        // exports
  ...section(10, [1, ...[7, 0, 0x20, 0, 0x2d, 0, 0, 0x0b]]),                     // read: local.get 0; i32.load8_u; end
  ...section(11, [2, 0, 0x41, 16, 0x0b, ...str("abc"), 0, 0x41, 100, 0x0b, ...str("xy")]),
]);
const text = (bytes) => Buffer.from(bytes).toString();

test("splitWasm: the program without its data, and the segments", async () => {
  assert.ok(WebAssembly.validate(WASM));
  const { code, segments } = splitWasm(WASM);
  assert.ok(code.length < WASM.length);
  assert.deepEqual(segments.map((s) => [s.offset, text(s.bytes)]), [[16, "abc"], [100, "xy"]]);
  const { instance } = await WebAssembly.instantiate(code);
  assert.equal(instance.exports.read(16), 0); // no data yet
});

test("segmentWriter: chunks of any size land at the segments' offsets; finish() checks completeness", async () => {
  const { code, segments } = splitWasm(WASM);
  const table = segments.map((s) => ({ offset: s.offset, length: s.bytes.length }));
  const { instance } = await WebAssembly.instantiate(code);
  const write = segmentWriter(instance.exports.memory, table);
  write(Buffer.from("ab")); write(Buffer.from("cx")); write(Buffer.from("y"));
  write.finish();
  const read = (i) => String.fromCharCode(instance.exports.read(i));
  assert.equal([16, 17, 18, 100, 101].map(read).join(""), "abcxy");
  assert.throws(() => write(Buffer.from("z")), /longer than its segment table/);

  const short = segmentWriter((await WebAssembly.instantiate(code)).instance.exports.memory, table);
  short(Buffer.from("abc"));
  assert.throws(() => short.finish(), /shorter than its segment table/);
});

test("initWithData: the data is in memory before the glue's start code runs", async () => {
  const { code, segments } = splitWasm(WASM);
  const table = segments.map((s) => ({ offset: s.offset, length: s.bytes.length }));
  let seenAtStart = null;
  // what a wasm-bindgen glue does: instantiate, then run the start code
  const init = async ({ module_or_path }) => {
    const result = await WebAssembly.instantiate(module_or_path, {});
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    seenAtStart = String.fromCharCode(instance.exports.read(16), instance.exports.read(100));
    return instance.exports;
  };
  async function* chunks() { yield Buffer.from("abcxy"); }
  const real = WebAssembly.instantiate;
  // another program instantiated meanwhile (Node's fetch does this) is left alone
  const other = WebAssembly.compile(code).then((m) => { const p = WebAssembly.instantiate(m); return p; });
  await initWithData(init, code, table, chunks());
  assert.equal(seenAtStart, "ax");
  assert.equal((await other).exports.read(16), 0);
  assert.equal(WebAssembly.instantiate, real); // put back
});
