#!/usr/bin/env python3
"""ccprobe: a local, read-only live dashboard of Claude Code sessions, their agents and the worker queue.

    python3 ccprobe.py            serve on http://127.0.0.1:8787 (prints the URL with its access token)
    python3 ccprobe.py --open     ... and open it in the browser
    python3 ccprobe.py --url      print the URL with the token and exit
    python3 ccprobe.py --once     run one collection and print the model as JSON (for debugging)
"""
import argparse
import ipaddress
import json
import re
import subprocess
import sys

from ccprobe import model, server


def duration(s):
    m = re.fullmatch(r"(\d+)\s*([smhd]?)", s.strip())
    if not m:
        raise argparse.ArgumentTypeError("use e.g. 45m, 6h, 1d")
    return int(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--i-know-this-exposes-transcripts", dest="exposed_ok", action="store_true",
                    help="allow a non-loopback --host (the page shows transcript excerpts)")
    ap.add_argument("--window", type=duration, default=duration("6h"), help="how far back agents and events are shown (6h)")
    ap.add_argument("--ctx-max", type=int, default=1_000_000, help="context window size for the gauges (1000000)")
    ap.add_argument("--interval", type=float, default=1.5, help="seconds between collections (1.5)")
    ap.add_argument("--no-token", action="store_true", help="do not require the access token (loopback only)")
    ap.add_argument("--open", action="store_true", help="open the dashboard in the default browser")
    ap.add_argument("--url", action="store_true", help="print the dashboard URL with its token and exit")
    ap.add_argument("--once", action="store_true", help="collect once, print the model as JSON, exit")
    a = ap.parse_args()

    try:
        loopback = ipaddress.ip_address(a.host).is_loopback
    except ValueError:
        loopback = a.host == "localhost"
    if not loopback and not a.exposed_ok:
        sys.exit("ccprobe: refusing to listen beyond this machine; pass --i-know-this-exposes-transcripts to insist")
    if a.no_token and not loopback:
        sys.exit("ccprobe: --no-token is only allowed on loopback")

    token = server.load_token()
    host = "127.0.0.1" if a.host in ("127.0.0.1", "0.0.0.0") else a.host
    url = f"http://{host}:{a.port}/" + ("" if a.no_token else f"?t={token}")
    if a.url:
        print(url)
        return

    col = model.Collector(window_s=a.window, ctx_max=a.ctx_max)
    if a.once:
        col.tick()              # learns which transcripts to count
        col.books.step()        # counts them (a running server does this on its own thread)
        print(json.dumps(col.tick(), indent=1, default=str))
        return

    httpd = server.Server((a.host, a.port), server.make_handler(col, token, a.port, use_token=not a.no_token, host=a.host))
    server.run_collector(col, a.interval)
    print(f"ccprobe {model.VERSION} · read-only · {url}", flush=True)
    if a.open:
        subprocess.run(["open", url], check=False)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        col.stopping = True
        httpd.server_close()


if __name__ == "__main__":
    main()
