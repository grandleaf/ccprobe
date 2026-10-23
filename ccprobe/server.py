"""HTTP: the page, /api/state (JSON) and /api/events (SSE). Loopback only, token-gated, no file-path endpoint."""
import hmac
import http.server
import json
import os
import secrets
import threading
import time
import urllib.parse

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
FILES = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
         "app.css": "text/css; charset=utf-8", "theme.js": "text/javascript; charset=utf-8",
         "icon.svg": "image/svg+xml"}
TOKEN_FILE = os.path.expanduser("~/.config/ccprobe/token")
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            t = f.read().strip()
            if len(t) >= 32:
                return t
    except OSError:
        pass
    os.makedirs(os.path.dirname(TOKEN_FILE), mode=0o700, exist_ok=True)
    t = secrets.token_urlsafe(32)
    try:
        os.unlink(TOKEN_FILE)            # a short or unreadable old token: replace it, never write through a link
    except OSError:
        pass
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(t)
    return t


def make_handler(collector, token, port, use_token=True, host=None):
    COOKIE = f"ccprobe_{port}"          # cookies ignore ports: one name per port
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"} | ({f"{host}:{port}"} if host else set())

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "ccprobe"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):   # quiet: no request log (URLs could carry the token)
            pass

        def _headers(self, code, ctype, length=None, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CSP)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.end_headers()

        def _send(self, code, ctype, body, extra=None):
            if isinstance(body, str):
                body = body.encode()
            self._headers(code, ctype, len(body), extra)
            if self.command != "HEAD":
                self.wfile.write(body)

        def _authed(self):
            if not use_token:
                return True
            got = self.headers.get("X-Ccprobe-Token", "")
            if not got:
                for part in self.headers.get("Cookie", "").split(";"):
                    k, _, v = part.strip().partition("=")
                    if k == COOKIE:
                        got = v
            return bool(got) and hmac.compare_digest(got.encode(), token.encode())

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if self.headers.get("Host", "") not in hosts:      # DNS-rebinding guard
                return self._send(421, "text/plain", "wrong host\n")
            url = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(url.query)
            if use_token and "t" in q:
                if hmac.compare_digest(q["t"][0].encode(), token.encode()):
                    cookie = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000"
                    return self._send(303, "text/plain", "ok\n", {"Location": "/", "Set-Cookie": cookie})
                return self._send(403, "text/plain", "bad token\n")
            if not self._authed():
                return self._send(401, "text/html; charset=utf-8",
                                  "<!doctype html><title>ccprobe</title><p style='font:14px monospace'>ccprobe: open the URL "
                                  "the server printed (it carries the token), or run <code>python3 ccprobe.py --url</code>.</p>")
            path = url.path
            if path == "/":
                path = "/index.html"
            if path == "/api/state":
                body = collector.snapshot_json()
                return self._send(200, "application/json", body or json.dumps({"v": 1, "loading": True}))
            if path == "/api/health":
                return self._send(200, "application/json", json.dumps({"ok": True, "ready": collector.snapshot()[0] is not None}))
            if path == "/api/events":
                return self._sse()
            name = path.lstrip("/")
            if name.startswith("static/"):
                name = name[7:]
            if name in FILES:                      # an allow-list: never a path from the URL
                with open(os.path.join(STATIC, name), "rb") as f:
                    return self._send(200, FILES[name], f.read())
            return self._send(404, "text/plain", "not found\n")

        def _sse(self):
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command == "HEAD":          # headers only: never hold a HEAD request open as a stream
                return
            last, ping = None, time.time()
            try:
                self.wfile.write(b"retry: 2000\n\n")
                while not collector.stopping:
                    model, digest = collector.snapshot()
                    if model is not None and digest != last:
                        last = digest
                        self.wfile.write(b"data: " + collector.snapshot_json().encode() + b"\n\n")
                        self.wfile.flush()
                        ping = time.time()
                    elif time.time() - ping >= 5:
                        # a heartbeat with the server time keeps the page's "live" pill honest
                        self.wfile.write(f"event: ping\ndata: {time.time():.1f}\n\n".encode())
                        self.wfile.flush()
                        ping = time.time()
                    collector.changed.wait(1.0)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    return Handler


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_collector(collector, interval):
    collector.stopping = False
    collector.changed = threading.Event()

    def loop():
        while not collector.stopping:
            t0 = time.time()
            try:
                collector.tick()
            except Exception as e:      # keep the last good model and try again next tick
                collector.last_error = f"{type(e).__name__}: {e}"
            collector.changed.set()
            collector.changed.clear()
            time.sleep(max(0.2, interval - (time.time() - t0)))

    th = threading.Thread(target=loop, name="collector", daemon=True)
    th.start()
    return th
