// Check the generated package exports, without ambient Node types leaking into browser consumers.
import { createPool, KakeraError, type EngineStatus, type LoadResult, type WorkerResponse } from "kakera";
import { fileStore, memoryStorage, collect } from "kakera/files";
import { serveEngine, withTransfer } from "kakera/worker";
import { splitFile, writeManifest, contentVersion } from "kakera/split";
import { splitWasm, segmentWriter, initWithData } from "kakera/wasm";
import { codedError, errorCode } from "kakera/errors";

class AnalyzerError extends KakeraError {}
const pool = createPool({ prefix: "types", ErrorClass: AnalyzerError });
const handle = pool.handle({ name: "analyzer", filesUrl: "/files/", workerUrl: "/worker.js", crashGuard: false });
handle.on("status", (status) => { const state: EngineStatus = status; void state; });
handle.on("progress", (progress) => { const fraction: number = progress.fraction; void fraction; });
handle.on("log", (line) => line.toUpperCase());
// @ts-expect-error Unknown event names must be rejected.
handle.on("missing", () => {});
// @ts-expect-error Listener payload must match the event.
handle.on("status", (progress: { fraction: number }) => {});
// @ts-expect-error Required engine options must be provided.
pool.handle({ name: "analyzer" });
const loaded: Promise<LoadResult> = handle.load();
const result: Promise<{ words: string[] }> = handle.call("analyze", { text: "日本語" });
const unknownResult = await handle.call("analyze");
// @ts-expect-error A worker result needs an explicit type before accessing fields.
unknownResult.words;
// @ts-expect-error Invalid status values must be rejected.
const invalidStatus: EngineStatus = "finished";
void [loaded, result, invalidStatus];

const storage = memoryStorage();
const store = fileStore({ storage });
await store.load("https://example.test/manifest.json", {
  async onFile(file, chunks, manifest) {
    const bytes: Uint8Array = await collect(chunks, file.size);
    const name: string = manifest.name;
    void [bytes, name];
  },
  onProgress(progress) { const bytes: number | undefined = progress.downloaded; void bytes; },
});
serveEngine({
  async load(message, context) {
    await context.loadFiles({ async onFile(file, chunks) { await collect(chunks, file.size); } });
    context.step("warmup");
    void message;
  },
  calls: { async audio(_message, context) {
    context.alive();
    const samples = new Float32Array(10);
    return withTransfer({ samples }, [samples.buffer]);
  } },
});
function message(response: WorkerResponse) {
  if (response.type === "error") response.message.toUpperCase();
  if (response.type === "progress") {
    const loaded: number | undefined = response.loaded;
    // @ts-expect-error Progress is not a completed call.
    response.result;
    void loaded;
  }
}
const split = splitFile(new Uint8Array(1), { name: "data", outDir: "/tmp/types" });
writeManifest("/tmp/types", { name: "data", version: contentVersion(new Uint8Array(1)), files: [split] });
const memory = new WebAssembly.Memory({ initial: 1 });
const write = segmentWriter(memory, [{ offset: 0, length: 1 }]);
write(new Uint8Array(1)); write.finish();
const initialized: Promise<{ memory: WebAssembly.Memory }> = initWithData(async () => ({ memory }), new Uint8Array(), [], []);
void [message, initialized, splitWasm, codedError("custom", "message"), errorCode(null)];
