#!/usr/bin/env bash
# Prove what a generated Caddyfile stops at the edge, against a stub upstream.
#
# Usage: scripts/check_caddy_edge.sh <path-to-generated-Caddyfile>
#
# Caddy runs the Caddyfile unchanged except for the site address, which is
# overridden through SITE_ADDRESS (exactly as in production) to plain HTTP on
# :8080, so no certificate is involved. The upstream is a small Python server
# that records every request it is handed and reads every body to the end.
#
# The two share one network namespace, so the stub listening on port 3000 is
# exactly where the Caddyfile's `reverse_proxy 127.0.0.1:3000` points — the
# same hop as in production, where Caddy is on the host's network and the app
# is published on its loopback.
#
# Asserted:
#   - each scanner path gets Caddy's 404 and never reaches the upstream;
#   - ordinary paths, including near misses, do reach it;
#   - a body over the cap gets 413, on each tightly capped route and globally,
#     whether it is announced by Content-Length or streamed chunked;
#   - a body under the cap is passed through whole;
#   - an event stream arrives as it is written, not when it ends;
#   - the JSON access log marks every refusal with a `blocked` field, and only
#     refusals.
set -euo pipefail

CADDYFILE="${1:?usage: check_caddy_edge.sh <path-to-generated-Caddyfile>}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

[[ -f "$CADDYFILE" ]] || fail "no such file: $CADDYFILE"
ABS="$(cd "$(dirname "$CADDYFILE")" && pwd)/$(basename "$CADDYFILE")"

TAG="edge-check-$$"
NET="$TAG"
STUB="$TAG-stub"
CADDY="$TAG-caddy"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$CADDY" "$STUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── Stub upstream ────────────────────────────────────────────────────────────
# Prints "SEEN <method> <path> <bytes>" once it has read a request's whole
# body, so its log is the record of what got past Caddy. /stream answers as an
# event stream: one event, a pause, a second event.
cat > "$WORK/stub.py" <<'PY'
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def body_length(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            total = 0
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    return total
                total += len(self.rfile.read(size))
                self.rfile.readline()
        length = int(self.headers.get("Content-Length") or 0)
        return len(self.rfile.read(length)) if length else 0

    def handle_any(self):
        n = self.body_length()
        print("SEEN %s %s %d" % (self.command, self.path, n), flush=True)
        if self.path.startswith("/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"data: first\n\n")
            self.wfile.flush()
            time.sleep(4)
            self.wfile.write(b"data: second\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        out = ("upstream saw %d bytes\n" % n).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_HEAD = handle_any


ThreadingHTTPServer(("0.0.0.0", 3000), Stub).serve_forever()
PY

docker network create "$NET" >/dev/null
# The stub owns the network namespace, so it is the container that publishes
# Caddy's port to the host.
docker run -d --name "$STUB" --network "$NET" \
  -p 127.0.0.1::8080 -v "$WORK/stub.py:/stub.py:ro" \
  python:3-alpine python -u /stub.py >/dev/null
docker run -d --name "$CADDY" --network "container:$STUB" \
  -e SITE_ADDRESS=:8080 -v "$ABS:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null

PORT="$(docker port "$STUB" 8080/tcp | head -1 | sed 's/.*://')"
[[ -n "$PORT" ]] || fail "could not find the published port"
BASE="http://127.0.0.1:$PORT"

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

# Ready means the whole hop works: Caddy can be up before the stub listens, and
# answers 502 meanwhile.
for _ in $(seq 30); do
  [[ "$(status "$BASE/" || true)" == 200 ]] && break
  sleep 1
done
[[ "$(status "$BASE/" || true)" == 200 ]] || {
  docker logs "$CADDY" >&2 || true
  docker logs "$STUB" >&2 || true
  fail "no 200 through Caddy from the stub on $BASE"
}

# Bodies of a given size, made once.
body() {
  local f="$WORK/body-$1"
  [[ -f "$f" ]] || head -c "$1" /dev/zero | tr '\0' 'a' > "$f"
  echo "$f"
}

# ── Scanner probes ───────────────────────────────────────────────────────────
SCANNER_PATHS=(
  /.env /.env.local /.env.production.bak /.ENV
  /.git /.git/config /.git/HEAD
  /.aws/credentials /.ssh/id_rsa
  /wp-login.php /wp-admin /wp-admin/setup-config.php /wp-admin/css/x.css
  /wp-content/plugins/x/readme.txt /wp-includes/wlwmanifest.xml
  /xmlrpc.php
  /phpmyadmin /phpmyadmin/index.php /phpMyAdmin/
  /pma/index.php
  /index.php /admin/config.php /vendor/phpunit/src/Util/PHP/eval-stdin.php
  /cgi-bin/luci /cgi-bin/test.cgi
  /server-status /server-info
)
for p in "${SCANNER_PATHS[@]}"; do
  got="$(status "$BASE$p")"
  [[ "$got" == 404 ]] || fail "scanner path $p answered $got, expected Caddy's 404"
done
# A POST to a probe is blocked the same way, body or not.
got="$(status -X POST --data-binary @"$(body 100)" "$BASE/xmlrpc.php")"
[[ "$got" == 404 ]] || fail "POST /xmlrpc.php answered $got, expected 404"
pass "${#SCANNER_PATHS[@]} scanner paths and a POST probe answered 404 by Caddy"

# ── Ordinary requests pass ───────────────────────────────────────────────────
# Including near misses: names that contain the probed words without being the
# probed paths.
NORMAL_PATHS=(
  / /pricing /blog/php-tips /environment /api/auth/session
  /_next/static/chunks/main.js /.well-known/security.txt /gitlab /wp
)
for p in "${NORMAL_PATHS[@]}"; do
  got="$(status "$BASE$p")"
  [[ "$got" == 200 ]] || fail "ordinary path $p answered $got, expected the upstream's 200"
done
pass "${#NORMAL_PATHS[@]} ordinary paths reached the upstream"

# ── Body caps ────────────────────────────────────────────────────────────────
# route : a body that must pass : a body that must be refused
CAPS=(
  "/api/contact:60000:70000"
  "/api/age-check:60000:70000"
  "/api/unsubscribe:60000:70000"
  "/ingest/e/:1000000:1100000"
  "/api/webhook/stripe:9000000:10100000"
  "/api/anything:9000000:10100000"
)
for entry in "${CAPS[@]}"; do
  IFS=: read -r route under over <<<"$entry"

  got="$(status -X POST --data-binary @"$(body "$under")" "$BASE$route")"
  [[ "$got" == 200 ]] || fail "POST $route with $under bytes answered $got, expected 200"

  got="$(status -X POST --data-binary @"$(body "$over")" "$BASE$route")"
  [[ "$got" == 413 ]] || fail "POST $route with $over bytes (Content-Length) answered $got, expected 413"

  # Without a Content-Length Caddy cannot refuse up front; it has to count.
  got="$(status -X POST -H 'Transfer-Encoding: chunked' --data-binary @"$(body "$over")" "$BASE$route")"
  [[ "$got" == 413 ]] || fail "POST $route with $over bytes (chunked) answered $got, expected 413"
done
pass "each capped route passes a body under its cap and answers 413 over it"

# ── Event streams are not buffered ───────────────────────────────────────────
# The stub writes one event, waits four seconds, then writes another. Cut off
# after two seconds, the client must already hold the first.
stream="$(curl -sN --max-time 2 "$BASE/stream" || true)"
[[ "$stream" == *"data: first"* ]] \
  || fail "the event stream did not arrive as it was written (got '$stream')"
[[ "$stream" != *"data: second"* ]] \
  || fail "the stub's pause did not happen; this check proved nothing"
pass "an event stream reaches the client as it is written"

# ── The upstream never saw a probe ───────────────────────────────────────────
seen="$(docker logs "$STUB" 2>&1)"
for p in "${SCANNER_PATHS[@]}" /xmlrpc.php; do
  if grep -qF "SEEN GET $p " <<<"$seen" || grep -qF "SEEN POST $p " <<<"$seen"; then
    fail "scanner path $p reached the upstream"
  fi
done
grep -qF "SEEN GET /pricing 0" <<<"$seen" || fail "the upstream's own log is not recording requests"
# A Content-Length body over its cap is refused before the upstream is asked.
if grep -qE "^SEEN POST /api/contact 70000$" <<<"$seen"; then
  fail "an oversized body reached the upstream whole"
fi
pass "no scanner probe and no oversized body reached the upstream"

# ── Access log ───────────────────────────────────────────────────────────────
# Read through the container: on the host the file is root's, mode 0640.
docker exec "$CADDY" cat /var/log/caddy/access.log > "$WORK/access.log" \
  || fail "no access log at /var/log/caddy/access.log"
python3 - "$WORK/access.log" "${#SCANNER_PATHS[@]}" <<'PY' || fail "access log check failed (above)"
import json
import sys

path, scanner_count = sys.argv[1], int(sys.argv[2])
lines = [json.loads(l) for l in open(path) if l.strip()]
access = [l for l in lines if l.get("logger", "").startswith("http.log.access")]
problems = []
if not access:
    problems.append("no access entries in the log")

scanner = [l for l in access if l.get("blocked") == "scanner"]
too_large = [l for l in access if l.get("blocked") == "body_too_large"]
other = [l for l in access if "blocked" in l and l["blocked"] not in ("scanner", "body_too_large")]

# Every scanner path plus the POST probe.
if len(scanner) != scanner_count + 1:
    problems.append("expected %d scanner-blocked entries, found %d" % (scanner_count + 1, len(scanner)))
if any(l.get("status") != 404 for l in scanner):
    problems.append("a scanner-blocked entry is not a 404")
# Six routes, each refused twice (Content-Length and chunked).
if len(too_large) != 12:
    problems.append("expected 12 body_too_large entries, found %d" % len(too_large))
if any(l.get("status") != 413 for l in too_large):
    problems.append("a body_too_large entry is not a 413")
if other:
    problems.append("unexpected blocked values: %s" % sorted({l["blocked"] for l in other}))
unmarked = [l for l in access if "blocked" not in l and l.get("status") in (404, 413)]
if unmarked:
    problems.append("refusals without the marker: %s" % [(l["request"]["uri"], l["status"]) for l in unmarked])
marked_ok = [l for l in access if "blocked" in l and l.get("status") == 200]
if marked_ok:
    problems.append("passed requests carrying the marker: %s" % [l["request"]["uri"] for l in marked_ok])

for p in problems:
    print("  " + p, file=sys.stderr)
sys.exit(1 if problems else 0)
PY
pass "the JSON access log marks every refusal with \"blocked\", and nothing else"

echo "==> Edge check passed"
