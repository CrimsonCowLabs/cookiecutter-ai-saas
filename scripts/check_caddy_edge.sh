#!/usr/bin/env bash
# Prove what a generated Caddyfile stops at the edge, against a stub upstream.
#
# Usage: scripts/check_caddy_edge.sh <path-to-generated-Caddyfile>
#
# Caddy is the project's own build (caddy/Dockerfile, with the rate-limit
# module) and runs the Caddyfile unchanged except for the site address, which
# is overridden through SITE_ADDRESS (exactly as in production) to plain HTTP
# on :8080, so no certificate is involved. The upstream is a small Python server
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
#     refusals;
# and then, with Caddy restarted on deliberately low limits (set through the
# same environment variables production would use):
#   - a burst from one client past the general limit gets 429 with a
#     Retry-After, everywhere on the site, while a client at another address is
#     unaffected;
#   - sign-in, the contact form, server actions and ingest trip at their own,
#     tighter limits, each in its own budget, while an ordinary page from the
#     same client still passes;
#   - the SSE progress stream and the Stripe webhook keep passing a client the
#     general limit has already shut out;
#   - every 429 is in the access log as `"blocked":"rate_limited"`.
#
# The limits are low only in the second half. The first half runs on the
# Caddyfile's defaults, which is itself a check: a few dozen requests from one
# address, as a browser makes, must not trip them.
set -euo pipefail

CADDYFILE="${1:?usage: check_caddy_edge.sh <path-to-generated-Caddyfile>}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

[[ -f "$CADDYFILE" ]] || fail "no such file: $CADDYFILE"
PROJECT_DIR="$(cd "$(dirname "$CADDYFILE")" && pwd)"
ABS="$PROJECT_DIR/$(basename "$CADDYFILE")"

# shellcheck source=lib/caddy_image.sh
source "$(dirname "$0")/lib/caddy_image.sh"
IMAGE="$(caddy_image_build "$PROJECT_DIR")" || fail "no Caddy image for $PROJECT_DIR"
PYTHON_IMAGE=python:3-alpine

TAG="edge-check-$$"
NET="$TAG"
STUB="$TAG-stub"
CADDY="$TAG-caddy"
WORK="$(mktemp -d)"
CLIENTS=()

cleanup() {
  docker rm -f "$CADDY" "$STUB" ${CLIENTS[@]+"${CLIENTS[@]}"} >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── Stub upstream ────────────────────────────────────────────────────────────
# Prints "SEEN <method> <path> <bytes>" once it has read a request's whole
# body, so its log is the record of what got past Caddy. A path ending in
# /progress (the shape of the app's job-progress route) answers as an event
# stream: one event, a pause, a second event.
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
        if self.path.split("?")[0].endswith("/progress"):
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
  "$PYTHON_IMAGE" python -u /stub.py >/dev/null

PORT="$(docker port "$STUB" 8080/tcp | head -1 | sed 's/.*://')"
[[ -n "$PORT" ]] || fail "could not find the published port"
BASE="http://127.0.0.1:$PORT"

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

# start_caddy [ENV=VALUE]...: (re)starts Caddy in the stub's namespace with
# those variables set, and waits until the whole hop works. A fresh container
# is a fresh access log and a fresh set of rate limiters.
start_caddy() {
  local env=() kv
  for kv in "$@"; do env+=(-e "$kv"); done
  docker rm -f "$CADDY" >/dev/null 2>&1 || true
  docker run -d --name "$CADDY" --network "container:$STUB" \
    -e SITE_ADDRESS=:8080 ${env[@]+"${env[@]}"} -v "$ABS:/etc/caddy/Caddyfile:ro" \
    "$IMAGE" >/dev/null
  # Ready means the whole hop works: Caddy can be up before the stub listens,
  # and answers 502 meanwhile. Asked from inside the namespace, so these
  # requests come from 127.0.0.1 and spend no client's budget.
  local _
  for _ in $(seq 30); do
    ready && return 0
    sleep 1
  done
  docker logs "$CADDY" >&2 || true
  docker logs "$STUB" >&2 || true
  fail "no 200 through Caddy from the stub"
}
ready() {
  docker exec "$STUB" python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/')" 2>/dev/null
}

# Production's defaults.
start_caddy

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
stream="$(curl -sN --max-time 2 "$BASE/api/jobs/abc/progress" || true)"
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
# check_log SCANNER BODY_TOO_LARGE RATE_LIMITED: the running Caddy's access log
# holds exactly that many entries with each `blocked` marker, each with its
# own status (404, 413, 429), and no refusal without one. Read through the
# container: on the host the file is root's, mode 0640.
check_log() {
  docker exec "$CADDY" cat /var/log/caddy/access.log > "$WORK/access.log" \
    || fail "no access log at /var/log/caddy/access.log"
  python3 - "$WORK/access.log" "$@" <<'PY' || fail "access log check failed (above)"
import json
import sys

path = sys.argv[1]
want = dict(zip(("scanner", "body_too_large", "rate_limited"), map(int, sys.argv[2:5])))
status_of = {"scanner": 404, "body_too_large": 413, "rate_limited": 429}
lines = [json.loads(l) for l in open(path) if l.strip()]
access = [l for l in lines if l.get("logger", "").startswith("http.log.access")]
problems = []
if not access:
    problems.append("no access entries in the log")

for marker, count in want.items():
    entries = [l for l in access if l.get("blocked") == marker]
    if len(entries) != count:
        problems.append("expected %d %s entries, found %d" % (count, marker, len(entries)))
    wrong = [(l["request"]["uri"], l.get("status")) for l in entries if l.get("status") != status_of[marker]]
    if wrong:
        problems.append("%s entries not answered %d: %s" % (marker, status_of[marker], wrong))
other = [l for l in access if "blocked" in l and l["blocked"] not in want]
if other:
    problems.append("unexpected blocked values: %s" % sorted({l["blocked"] for l in other}))
unmarked = [l for l in access if "blocked" not in l and l.get("status") in (404, 413, 429)]
if unmarked:
    problems.append("refusals without the marker: %s" % [(l["request"]["uri"], l["status"]) for l in unmarked])
marked_ok = [l for l in access if "blocked" in l and l.get("status") == 200]
if marked_ok:
    problems.append("passed requests carrying the marker: %s" % [l["request"]["uri"] for l in marked_ok])

for p in problems:
    print("  " + p, file=sys.stderr)
sys.exit(1 if problems else 0)
PY
}

# Every scanner path plus the POST probe; six capped routes, each refused
# twice (Content-Length and chunked); and nothing rate-limited, because the
# defaults leave this much traffic from one address alone.
check_log "$(( ${#SCANNER_PATHS[@]} + 1 ))" 12 0
pass "the JSON access log marks every refusal with \"blocked\", and nothing else"

# ── Rate limits ──────────────────────────────────────────────────────────────
# Caddy again, on limits low enough to reach in a few requests and windows long
# enough that none of them expires while this runs.
GENERAL=20
STRICT=3
INGEST=6
start_caddy \
  CADDY_RATE_LIMIT_EVENTS=$GENERAL CADDY_RATE_LIMIT_WINDOW=5m \
  CADDY_STRICT_RATE_LIMIT_EVENTS=$STRICT CADDY_STRICT_RATE_LIMIT_WINDOW=5m \
  CADDY_INGEST_RATE_LIMIT_EVENTS=$INGEST CADDY_INGEST_RATE_LIMIT_WINDOW=5m
TARGET="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$STUB")"
[[ -n "$TARGET" ]] || fail "could not find the proxy's address on $NET"

# Reads "METHOD PATH [HEADER: VALUE]" lines on stdin and sends each on its own
# connection. Prints this client's address, then "METHOD PATH STATUS" for each
# request, with " retry-after=<value>" added whenever the answer carried one.
# Only the head of each answer is read, so an event stream does not hold it up.
cat > "$WORK/client.py" <<'PY'
import http.client
import os
import socket
import sys

TARGET = os.environ["TARGET"]

with socket.create_connection((TARGET, 8080)) as s:
    print("ADDR", s.getsockname()[0], flush=True)

for line in sys.stdin:
    if not line.strip():
        continue
    method, path, *header = line.split(None, 2)
    headers = {"Host": "edge.test", "Content-Length": "0"}
    if header:
        name, value = header[0].split(":", 1)
        headers[name.strip()] = value.strip()
    conn = http.client.HTTPConnection(TARGET, 8080, timeout=20)
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    out = "%s %s %d" % (method, path, resp.status)
    if resp.getheader("Retry-After") is not None:
        out += " retry-after=" + resp.getheader("Retry-After")
    print(out, flush=True)
    conn.close()
PY

# client NAME < plan: runs one client from its own container, and leaves the
# container running until the end. Never at the end of a pipeline: in a
# subshell it would forget the container, and cleanup would leave it behind. Docker hands a stopped container's address
# straight to the next one, and two clients sharing an address would make every
# "another address is unaffected" below vacuous.
client() {
  local name="$1"
  CLIENTS+=("$TAG-$name")
  docker run -d --name "$TAG-$name" --network "$NET" \
    -v "$WORK/client.py:/client.py:ro" "$PYTHON_IMAGE" sleep 600 >/dev/null
  docker exec -i -e TARGET="$TARGET" "$TAG-$name" python -u /client.py > "$WORK/answers-$name" \
    || fail "client $name failed: $(cat "$WORK/answers-$name")"
  sed -n 's/^ADDR //p' "$WORK/answers-$name" >> "$WORK/addrs"
}

# answers NAME: what the client was answered, with each Retry-After checked —
# a whole number of seconds, at least one and no more than the window — and
# then shown only as its presence, so plans can be compared exactly.
answers() {
  local line ra
  while read -r line; do
    [[ "$line" == ADDR\ * ]] && continue
    if [[ "$line" == *" retry-after="* ]]; then
      ra="${line##* retry-after=}"
      [[ "$ra" =~ ^[0-9]+$ ]] && (( ra >= 1 && ra <= 300 )) \
        || fail "client $1 got Retry-After '$ra' on '${line% retry-after=*}', not 1-300 seconds"
      line="${line% retry-after=*} retry-after"
    fi
    echo "$line"
  done < "$WORK/answers-$1"
}

# expect NAME "ANSWER"...: the client was answered exactly so.
expect() {
  local name="$1"; shift
  local want got
  want="$(printf '%s\n' "$@")"
  got="$(answers "$name")"
  [[ "$got" == "$want" ]] || fail "client $name was answered
$got
expected
$want"
}

# repeat N LINE: LINE, N times.
repeat() { local i; for ((i = 0; i < $1; i++)); do echo "$2"; done; }

# The general limit. One client spends it on pages and is then refused
# everywhere — a page it never asked for included — except on the routes
# exempt from it: the job-progress stream (an EventSource reconnects by
# itself, and each one is a signed-in user's own job) and the Stripe webhook
# (Stripe's few addresses retry in bursts, and dropping one loses a billing
# event).
{
  repeat "$GENERAL" "GET /"
  echo "GET /"
  echo "GET /pricing"
  repeat 3 "GET /api/jobs/abc/progress"
  repeat 3 "POST /api/webhook/stripe"
} > "$WORK/plan-burst"
client burst < "$WORK/plan-burst"
want=()
for _ in $(seq "$GENERAL"); do want+=("GET / 200"); done
want+=("GET / 429 retry-after" "GET /pricing 429 retry-after")
for _ in 1 2 3; do want+=("GET /api/jobs/abc/progress 200"); done
for _ in 1 2 3; do want+=("POST /api/webhook/stripe 200"); done
expect burst "${want[@]}"
pass "a burst past the general limit of $GENERAL gets 429 with Retry-After, site-wide"
pass "the SSE progress stream and the Stripe webhook still pass a client the general limit has shut out"

# Somebody else, at the same moment.
printf '%s\n' "GET /" "GET /pricing" > "$WORK/plan-bystander"
client bystander < "$WORK/plan-bystander"
expect bystander "GET / 200" "GET /pricing 200"
pass "a client at another address is unaffected by the burst"

# The tight limits, each its own budget: spending sign-in's does not touch the
# contact form's. A server action is a POST carrying Next-Action, to whatever
# page it was rendered on; the same POST without the header is not one. And
# none of it shuts the client out of an ordinary page.
{
  repeat $((STRICT + 1)) "POST /api/auth/signin/resend"
  repeat $((STRICT + 1)) "POST /api/contact"
  repeat $((STRICT + 1)) "POST /dashboard Next-Action: 7f3a9c"
  echo "POST /dashboard"
  echo "GET /dashboard"
} > "$WORK/plan-strict"
client strict < "$WORK/plan-strict"
want=()
for route in "POST /api/auth/signin/resend" "POST /api/contact" "POST /dashboard"; do
  for _ in $(seq "$STRICT"); do want+=("$route 200"); done
  want+=("$route 429 retry-after")
done
want+=("POST /dashboard 200" "GET /dashboard 200")
expect strict "${want[@]}"
pass "sign-in, contact and server actions each trip at the strict limit of $STRICT; ordinary pages do not"

# Ingest sits between the two: analytics batches are frequent but cheap, so
# its limit is above the strict one and below the general one.
{
  repeat $((INGEST + 1)) "POST /ingest/e/"
  echo "GET /"
} > "$WORK/plan-ingest"
client ingest < "$WORK/plan-ingest"
want=()
for _ in $(seq "$INGEST"); do want+=("POST /ingest/e/ 200"); done
want+=("POST /ingest/e/ 429 retry-after" "GET / 200")
expect ingest "${want[@]}"
pass "ingest trips at its own limit of $INGEST, between the strict and general ones"

[[ "$(sort -u "$WORK/addrs" | wc -l)" == 4 ]] \
  || fail "the clients did not each get their own address, so this proved nothing: $(tr '\n' ' ' < "$WORK/addrs")"

# Two from the burst, one per strict route, one from ingest.
check_log 0 0 6
pass "every 429 is in the access log as \"blocked\":\"rate_limited\", and nothing else is"

echo "==> Edge check passed"
