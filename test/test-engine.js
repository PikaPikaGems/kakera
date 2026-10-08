// A small engine for test/host.html: loads the fixture files through kakera, then answers test calls.
import { codedError } from "../src/errors.js";
import { collect } from "../src/files.js";
import { serveEngine, withTransfer } from "../src/worker.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sizes = {};

serveEngine({
  async load(msg, ctx) {
    const res = await ctx.loadFiles({
      onFile: async (file, chunks) => { sizes[file.name] = (await collect(chunks, file.size)).length; },
    });
    return { fromCache: res.fromCache, sizes };
  },
  calls: {
    echo: async ({ value }) => ({ value, sizes }),
    // busy for `ms`, saying "still working" every 50 ms
    busy: async ({ ms }, ctx) => { for (let t = 0; t < ms; t += 50) { await sleep(50); ctx.alive(); } return "finished"; },
    // busy for `ms` without a word (looks hung)
    silent: async ({ ms }) => { await sleep(ms); return "finished"; },
    oom: async () => { throw new RangeError("WebAssembly.Memory(): could not allocate memory"); },
    coded: async ({ code }) => { throw codedError(code, `failed with ${code}`); },
    audio: async () => { const a = new Float32Array(1000).fill(0.5); return withTransfer({ samples: a }, [a.buffer]); },
  },
});
