# kakera

> [!WARNING]
> This project is experimental. Use it at your own risk.

Shared plumbing for [wakachi](https://github.com/PikaPikaGems/wakachi) (Japanese furigana and word analysis) and
[yomiage](https://github.com/PikaPikaGems/yomiage) (Japanese text-to-speech): loading big files in the browser, on
phones, without trouble. *kakera* (欠片) means "fragments, pieces".

**Not meant to be installed by apps.** wakachi and yomiage bundle kakera into their own builds, so app developers only
install the package they want.

## What goes in here

Moved out of jp-tts-playground's `packages/jp-analyzer` and made generic:

| Piece | What it does |
|---|---|
| Split files | A command (`kakera split`) that cuts big files into gzip parts of at most 20 MB plus a `manifest.json` with checksums, so they fit GitHub Pages and Cloudflare Pages. wakachi's and yomiage's `copy-files` commands use it |
| Load in parts | Downloads the parts, checks them, unpacks them one at a time and stores the compressed parts in IndexedDB, so later visits download nothing. Streams into the destination (e.g. wasm memory) without holding a second full copy |
| Worker host | Runs an engine in a Web Worker, shared by every handle on the page: crash guard (never the same crash twice), stall timeouts, stop when idle or when the page is hidden, cancelling |
| Errors and statuses | One `Error` class with codes and one set of statuses, so wakachi and yomiage behave the same |
| Engine store | `engineStore(analyzerOrVoice)` (`kakera/store`): the state a settings page shows (status, on the device, download size, progress, last error) as one snapshot with `subscribe` / `getSnapshot`, for the packages' React hooks. No React inside |

## Use (inside wakachi / yomiage)

Page side:

```js
import { createPool, KakeraError } from "kakera";

export class VoiceError extends KakeraError {}
const pool = createPool({ prefix: "yomiage", ErrorClass: VoiceError });

const engine = pool.handle({
  name: "tsukuyomi",
  filesUrl: "/yomiage/",   // where manifest.json and the parts are
  workerUrl: "/yomiage/engine.js",   // may be on another site (it then needs CORS headers); or createWorker: () => new Worker(...)
  missingHint: 'run "yomiage copy-files"', // added to the error when the worker file is missing
  idleTimeout: 60_000, stopWhenHidden: true, crashGuard: { retryAfterDays: 7 }, loadStall: 60_000,
});
await engine.load();                                       // { fromCache, ms, timings: [{ step, file, part, at, ms }] }
const audio = await engine.call("speak", { text }, { stall: 20_000, signal });
engine.status; engine.on("status" | "progress" | "log", fn); engine.info(); engine.unload(); engine.dispose();
```

`progress` events: `{ stage: "downloading" | "preparing" | "ready", fraction, loaded, total, step, file, part, parts,
ms, ... }`: one fraction for the whole load (never goes backwards), a stable `stage` for labels and every `step` for
debugging. Engines add their own steps with `ctx.step(name, details)`.

Worker side (`engine.js`):

```js
import { serveEngine, withTransfer } from "kakera/worker";
import { collect } from "kakera/files";

serveEngine({
  async load(msg, ctx) { await ctx.loadFiles({ onFile: async (file, chunks) => { /* stream or collect(chunks, file.size) */ } }); },
  calls: { speak: async ({ text }, ctx) => { /* ...; ctx.alive() while working */ return withTransfer(result, [buffer]); } },
});
```

Programs with a big built-in dictionary (`kakera/wasm`): `splitWasm()` ships the dictionary as its own file, and
`segmentWriter()` / `initWithData()` write it straight into the program's memory, so browsers don't keep extra copies
(Safari kept two to three). wakachi uses it for Sudachi, yomiage for its phonemizer.

Node side (building the files): `kakera split --out <dir> --name <name> <file>...`, or `splitFile()` and
`writeManifest()` from `kakera/split`.

## Development

Use Node 22 or newer. Source code is TypeScript with strict checking. `npm ci` installs the build tools and runs
`prepare`, which builds JavaScript and declarations into `dist/`. After editing `src/`, run `npm run build`.
The generated `.d.ts` files come from the source; do not edit them by hand.

Before building wakachi or yomiage from sibling checkouts, run `npm ci` in kakera first. Both packages bundle the
built JavaScript. Their apps do not need TypeScript or a separate kakera installation.

## Tests

```bash
npm ci                          # install tools and build dist/
npm run test:types              # check all package exports and typed usage
npm test                        # Node: splitting, loading, checks, storage, offline, versions
node test/make-fixtures.mjs     # then serve this folder and open test/host.html
python3 -m http.server 8092     #   http://127.0.0.1:8092/test/host.html  (worker host, incl. a simulated crash)
python3 test/serve-cors.py 8099 <dir>   # a second origin with CORS headers, for testing files/workers on another site
```

## Licence

MIT, see [LICENSE](LICENSE).
