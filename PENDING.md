# Pending

- [ ] **Workers from another host** (for wakachi's and yomiage's "files on another host"): browsers refuse
      `new Worker(url)` for another origin. When `filesUrl` is cross-origin, start the worker from a same-origin blob
      (`import "<remote worker url>"`); the remote host must send CORS headers for the worker and the parts.
- [ ] CI: Node tests and test/host.html.
