# Pending

- [x] **Workers from another host** (2026-10-09): `handle({ workerUrl })` starts it with `startWorker()`, through a
      same-origin blob when cross-origin, and explains start failures (missing file, unreachable, no CORS).
- [x] Debug report for both packages (2026-10-09): versions, browser/device, files address and manifest, status and last error
      (code, message, cause), parts on the device, storage, crash guard record, last load's log with timings. No user
      text.
- [x] React hooks' shared state (2026-10-10): `engineStore()` in `kakera/store`, used by `useWakachiEngine()` /
      `useYomiageEngine()` and the use hooks. Also fixed: a handle said `"ready"` a moment before its own `load()`
      had finished, so a call made on that status event failed with `not-loaded`; it now says `"loading"` until then.
- [x] `clearCache()` (2026-10-10): stops the engine and puts every handle that loaded it back to `"not-loaded"`, so
      nothing downloads again until a `load()` (before, the next call silently downloaded everything again).
- [ ] CI: Node tests and test/host.html.
