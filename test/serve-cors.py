# A static server that sends CORS headers, for testing files and workers loaded from another site:
#   python3 test/serve-cors.py <port> [directory]
# Pages on http://localhost:<other port> can then use http://127.0.0.1:<port>/... (a different origin).
import http.server, sys, functools

class CORS(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
handler = functools.partial(CORS, directory=sys.argv[2] if len(sys.argv) > 2 else ".")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
