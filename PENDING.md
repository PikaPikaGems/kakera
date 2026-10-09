# Pending

- [x] **Workers from another host** (2026-10-09): `handle({ workerUrl })` starts it with `startWorker()`, through a
      same-origin blob when cross-origin, and explains start failures (missing file, unreachable, no CORS).
- [ ] Debug report for both packages: versions, browser/device, files address and manifest, status and last error
      (code, message, cause), parts on the device, storage, crash guard record, last load's log with timings. No user
      text. The React hooks (`use<Name>Engine()`) could share their state code here too.
- [ ] CI: Node tests and test/host.html.
