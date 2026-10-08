# kakera

Shared plumbing for [wakachi](https://github.com/PikaPikaGems/wakachi) (Japanese furigana and word analysis) and
[yomiage](https://github.com/PikaPikaGems/yomiage) (Japanese text-to-speech): loading big files in the browser, on
phones, without trouble. *kakera* (欠片) means "fragments, pieces".

**Not meant to be installed by apps.** wakachi and yomiage bundle kakera into their own builds, so app developers only
install the package they want.

## What goes in here

Moved out of jp-tts-playground's `packages/jp-analyzer`, made generic:

| Piece | What it does |
|---|---|
| Split files | A command (`kakera split`) that cuts big files into gzip parts of at most 20 MB plus a `manifest.json` with checksums, so they fit GitHub Pages and Cloudflare Pages. wakachi's and yomiage's `copy-files` commands use it |
| Load in parts | Downloads the parts, checks them, unpacks them one at a time and stores the compressed parts in IndexedDB, so later visits download nothing. Streams into the destination (e.g. wasm memory) without holding a second full copy |
| Worker host | Runs an engine in a Web Worker, shared by every handle on the page: crash guard (never the same crash twice), stall timeouts, stop when idle or when the page is hidden, cancelling |
| Errors and statuses | One `Error` class with codes and one set of statuses, so wakachi and yomiage behave the same |

## Licence

MIT, see [LICENSE](LICENSE).
