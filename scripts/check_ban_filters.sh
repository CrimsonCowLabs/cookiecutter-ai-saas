#!/usr/bin/env bash
# Prove what a generated project's fail2ban filters count, against a real
# Caddy access log.
#
# Usage: scripts/check_ban_filters.sh <generated-project-dir>
#
# The log is not a fixture. The project's own Caddyfile runs in the same Caddy
# image docker-compose.prod.yml pins, in front of a stub upstream, exactly as
# scripts/check_caddy_edge.sh runs it; a handful of clients send it traffic;
# then fail2ban's own `fail2ban-regex` reads the log Caddy wrote, with the
# filter files ansible/provision.yml installs. A fixture would only prove the
# filters match what somebody once believed a Caddy line looks like.
#
# Each client is its own container on the proxy's network, so each arrives
# with its own address. That is what lets this check say not only how many
# lines a filter matched but whose address it charged them to — and a filter
# that took the address from anywhere but the request's own `remote_ip` would
# charge the wrong one.
#
# The stub answers 200 unless a request carries `X-Stub-Status`, in which case
# it answers with that, so a client can make the app refuse it in any way the
# real app might without the URI having to say so.
#
# Asserted, per filter, as an exact count of matched lines per client address:
#   - caddy-scanner counts every probe Caddy blocked, and nothing else — not
#     the app's own 404s, not a 413;
#   - caddy-errors counts every 4xx, 413 and 429 included, whoever produced it;
#   - neither counts a 4xx on the Stripe webhook or an auth callback, which
#     are where a legitimate client's failures pile up;
#   - neither counts a 2xx, however many;
#   - a client who writes `"blocked":"scanner"`, a `"remote_ip"` of somebody
#     else's or a fake `"status":404` into its own headers and URI is counted
#     for what it did, under its own address, and nobody is framed;
#   - every line's timestamp is read by the filters' date pattern, so fail2ban
#     dates each failure by when Caddy saw it rather than when it read it.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_ban_filters.sh <generated-project-dir>}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

[[ -d "$PROJECT_DIR" ]] || fail "no such directory: $PROJECT_DIR"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
CADDYFILE="$PROJECT_DIR/Caddyfile"
FILTERS="$PROJECT_DIR/ansible/files/fail2ban"
[[ -f "$CADDYFILE" ]] || fail "no Caddyfile in $PROJECT_DIR — is this a generated project?"
for f in caddy-scanner caddy-errors; do
  [[ -f "$FILTERS/$f.conf" ]] || fail "no fail2ban filter at $FILTERS/$f.conf"
done

# The proxy is the image production runs. fail2ban is the one Ubuntu 24.04
# packages: the release provision.yml is tested against
# (scripts/lib/throwaway_host.sh), so the fail2ban that will read these
# filters on a provisioned host, regex dialect and date handling included.
CADDY_IMAGE="$(sed -n 's/^ *image: *\(caddy:[^ ]*\).*/\1/p' "$PROJECT_DIR/docker-compose.prod.yml" | head -1)"
[[ -n "$CADDY_IMAGE" ]] || fail "could not read the caddy image out of docker-compose.prod.yml"
FAIL2BAN_BASE=ubuntu:24.04
PYTHON_IMAGE=python:3-alpine

TAG="ban-filter-check-$$"
NET="$TAG"
STUB="$TAG-stub"
CADDY="$TAG-caddy"
F2B_IMAGE="$TAG-fail2ban"
WORK="$(mktemp -d)"
CLIENTS=()

cleanup() {
  docker rm -f "$CADDY" "$STUB" ${CLIENTS[@]+"${CLIENTS[@]}"} >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm -f "$F2B_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# fail2ban is built first: it is the slow part, and nothing about it depends on
# the traffic.
echo "==> Building fail2ban from $FAIL2BAN_BASE"
docker build -q -t "$F2B_IMAGE" - >/dev/null <<DOCKERFILE
FROM $FAIL2BAN_BASE
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fail2ban \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
docker run --rm "$F2B_IMAGE" fail2ban-regex --version

# ── Stub upstream ────────────────────────────────────────────────────────────
cat > "$WORK/stub.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        status = int(self.headers.get("X-Stub-Status") or 200)
        out = b"stub\n"
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = handle_any


ThreadingHTTPServer(("0.0.0.0", 3000), Stub).serve_forever()
PY

# ── Clients ──────────────────────────────────────────────────────────────────
# Reads "METHOD PATH STATUS-THE-STUB-GIVES [BODY-BYTES]" lines on stdin and
# sends each one, raw, so that nothing on the way normalises the path or the
# headers this check depends on. Prints this client's address, then each
# request with the status that came back.
cat > "$WORK/client.py" <<'PY'
import os
import socket
import sys

TARGET = (os.environ["TARGET"], 8080)
EXTRA = [h for h in os.environ.get("EXTRA_HEADERS", "").split("\n") if h]

with socket.create_connection(TARGET) as s:
    print("ADDR", s.getsockname()[0], flush=True)

for line in sys.stdin:
    if not line.strip():
        continue
    method, path, stub_status, *rest = line.split()
    size = int(rest[0]) if rest else 0
    head = [
        "%s %s HTTP/1.1" % (method, path),
        "Host: edge.test",
        "Connection: close",
        "X-Stub-Status: %s" % stub_status,
        "Content-Length: %d" % size,
    ] + EXTRA
    with socket.create_connection(TARGET) as s:
        s.sendall(("\r\n".join(head) + "\r\n\r\n").encode())
        try:
            s.sendall(b"a" * size)
        except OSError:
            pass  # Caddy may refuse an oversized body before it is all sent
        reply = b""
        while b"\r\n" not in reply:
            try:
                chunk = s.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            reply += chunk
    print(method, path, reply.split(b" ", 2)[1].decode(), flush=True)
PY

docker network create "$NET" >/dev/null
docker run -d --name "$STUB" --network "$NET" \
  -v "$WORK/stub.py:/stub.py:ro" "$PYTHON_IMAGE" python -u /stub.py >/dev/null
docker run -d --name "$CADDY" --network "container:$STUB" \
  -e SITE_ADDRESS=:8080 -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" >/dev/null
TARGET="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$STUB")"
[[ -n "$TARGET" ]] || fail "could not find the proxy's address on $NET"

# client NAME [EXTRA-HEADERS] < plan: runs one client, records its address in
# $WORK/addr-NAME and what it was answered in $WORK/answers-NAME. Each client
# is a container left running until the end: Docker hands a stopped
# container's address straight to the next one, and five clients sharing one
# address would make every attribution below vacuous.
client() {
  local name="$1" extra="${2:-}"
  CLIENTS+=("$TAG-$name")
  docker run -d --name "$TAG-$name" --network "$NET" \
    -v "$WORK/client.py:/client.py:ro" "$PYTHON_IMAGE" sleep 600 >/dev/null
  docker exec -i -e TARGET="$TARGET" -e EXTRA_HEADERS="$extra" "$TAG-$name" \
    python -u /client.py > "$WORK/answers-$name"
  sed -n 's/^ADDR //p' "$WORK/answers-$name" > "$WORK/addr-$name"
  [[ -s "$WORK/addr-$name" ]] || fail "client $name never connected: $(cat "$WORK/answers-$name")"
}

# expect_answers NAME "METHOD PATH STATUS"...: the client was answered exactly so.
expect_answers() {
  local name="$1"; shift
  local want got
  want="$(printf '%s\n' "$@")"
  got="$(grep -v '^ADDR ' "$WORK/answers-$name")"
  [[ "$got" == "$want" ]] || fail "client $name was answered
$got
expected
$want"
}

# Ready means the whole hop works: Caddy can be up before the stub listens.
# Asked from inside the proxy's own namespace, so these requests come from
# 127.0.0.1 and are told apart from every client's below.
ready() {
  docker exec "$STUB" python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/')" 2>/dev/null
}
for _ in $(seq 30); do
  ready && break
  sleep 1
done
ready || {
  docker logs "$CADDY" >&2 || true
  fail "no 200 through Caddy from the stub"
}

STARTED="$(date +%s)"

# A scanner: five probes Caddy answers itself, and one ordinary page.
client scanner <<'PLAN'
GET /.env 200
GET /wp-login.php 200
GET /.git/config 200
GET /phpmyadmin/index.php 200
GET /vendor/phpunit/src/Util/PHP/eval-stdin.php 200
GET / 200
PLAN
expect_answers scanner "GET /.env 404" "GET /wp-login.php 404" "GET /.git/config 404" \
  "GET /phpmyadmin/index.php 404" "GET /vendor/phpunit/src/Util/PHP/eval-stdin.php 404" "GET / 200"

# A client the app keeps refusing, in every 4xx shape it has, and Caddy
# refusing it once for an oversized body.
client noisy <<'PLAN'
GET /no-such-page 404
GET /no-such-page-either 404
GET /api/jobs 401
GET /dashboard/settings 403
POST /api/contact 429
POST /api/contact 429
POST /api/contact 200 70000
GET /pricing 200
GET /blog 200
PLAN
expect_answers noisy "GET /no-such-page 404" "GET /no-such-page-either 404" "GET /api/jobs 401" \
  "GET /dashboard/settings 403" "POST /api/contact 429" "POST /api/contact 429" \
  "POST /api/contact 413" "GET /pricing 200" "GET /blog 200"

# Stripe retrying a webhook the app rejected, and a user whose OAuth sign-in
# keeps failing at the callback: refused, legitimately, and never counted. A
# 4xx on the sign-in page itself is not exempt, and is counted.
client exempt <<'PLAN'
POST /api/webhook/stripe 400
POST /api/webhook/stripe 400
POST /api/webhook/stripe 500
POST /api/webhook/stripe 400
GET /api/auth/callback/google?code=x&state=y 401
GET /api/auth/callback/google?error=OAuthCallback 400
GET /api/auth/callback/azure-ad 403
GET /api/auth/signin 400
PLAN
expect_answers exempt "POST /api/webhook/stripe 400" "POST /api/webhook/stripe 400" \
  "POST /api/webhook/stripe 500" "POST /api/webhook/stripe 400" \
  "GET /api/auth/callback/google?code=x&state=y 401" \
  "GET /api/auth/callback/google?error=OAuthCallback 400" \
  "GET /api/auth/callback/azure-ad 403" "GET /api/auth/signin 400"

# A client trying to get somebody else banned, or itself let off: every field
# a filter reads, forged into its own headers and query string. It succeeds
# twice and fails once, and only that one failure is its own.
FORGED='","blocked":"scanner","request":{"remote_ip":"203.0.113.9","uri":"/.env"},"status":404,"resp_headers":{}}'
client forger "X-Forged: $FORGED
User-Agent: $FORGED" <<PLAN
GET /?x=$FORGED 200
GET /pricing 200
GET /missing?x=$FORGED 404
PLAN
expect_answers forger "GET /?x=$FORGED 200" "GET /pricing 200" "GET /missing?x=$FORGED 404"

# Somebody using the site.
client normal <<'PLAN'
GET / 200
GET /pricing 200
GET /api/auth/session 200
POST /api/webhook/stripe 200
GET /api/auth/callback/google?code=x&state=y 302
GET /dashboard 200
PLAN
expect_answers normal "GET / 200" "GET /pricing 200" "GET /api/auth/session 200" \
  "POST /api/webhook/stripe 200" "GET /api/auth/callback/google?code=x&state=y 302" "GET /dashboard 200"
pass "five clients, each from its own address, were answered as planned"

for name in scanner noisy exempt forger normal; do
  declare "ADDR_${name}=$(cat "$WORK/addr-$name")"
done
# shellcheck disable=SC2154  # assigned through declare above
[[ "$(printf '%s\n' "$ADDR_scanner" "$ADDR_noisy" "$ADDR_exempt" "$ADDR_forger" "$ADDR_normal" | sort -u | wc -l)" == 5 ]] \
  || fail "the clients did not each get their own address, so attribution proves nothing"

# ── The log Caddy wrote ──────────────────────────────────────────────────────
docker exec "$CADDY" cat /var/log/caddy/access.log > "$WORK/access.log" \
  || fail "no access log at /var/log/caddy/access.log"
# Only the clients' lines: the readiness probes came from 127.0.0.1.
grep -F -e "\"remote_ip\":\"$ADDR_scanner\"" -e "\"remote_ip\":\"$ADDR_noisy\"" \
  -e "\"remote_ip\":\"$ADDR_exempt\"" -e "\"remote_ip\":\"$ADDR_forger\"" \
  -e "\"remote_ip\":\"$ADDR_normal\"" "$WORK/access.log" > "$WORK/clients.log" || true
lines="$(wc -l < "$WORK/clients.log")"
[[ "$lines" == 32 ]] || fail "expected 32 access-log lines from the clients, found $lines"
# The forgery has to have reached the log, or it tested nothing.
grep -qF 'blocked\":\"scanner' "$WORK/clients.log" \
  || fail "the forged header is not in the access log, so this check proved nothing about it"

# ── What each filter makes of it ─────────────────────────────────────────────
# regex FILTER [ARGS]: fail2ban-regex on the clients' lines with the generated
# filter, mounted where provision.yml puts it.
regex() {
  local filter="$1"; shift
  docker run --rm -v "$WORK/clients.log:/access.log:ro" \
    -v "$FILTERS/$filter.conf:/etc/fail2ban/filter.d/$filter.conf:ro" \
    "$F2B_IMAGE" fail2ban-regex "$@" /access.log "/etc/fail2ban/filter.d/$filter.conf"
}

# counts FILTER: "<count> <address>" for every address the filter charged.
counts() {
  regex "$1" --out ip | sort | uniq -c | awk '{print $1, $2}' | sort -k2
}

# expect_counts FILTER "COUNT ADDRESS"...
expect_counts() {
  local filter="$1"; shift
  local want got
  want="$(printf '%s\n' "$@" | sort -k2)"
  got="$(counts "$filter")"
  [[ "$got" == "$want" ]] || fail "$filter charged
${got:-<nobody>}
expected
$want"
}

expect_counts caddy-scanner "5 $ADDR_scanner"
pass "caddy-scanner counts the five blocked probes, and nothing else, against the scanner"

# The scanner's five probes are 404s too. The noisy client's seven refusals
# include the 413 Caddy gave and both 429s. The exempt client is charged for
# the sign-in page alone, the forger for its one real 404.
expect_counts caddy-errors "5 $ADDR_scanner" "7 $ADDR_noisy" "1 $ADDR_exempt" "1 $ADDR_forger"
pass "caddy-errors counts every 4xx but the webhook's and the auth callbacks', each against its own client"

# Nobody was charged under the forged address, by either filter — which the
# counts above already imply, and which is the point, so it is said outright.
for filter in caddy-scanner caddy-errors; do
  if regex "$filter" --out ip | grep -qxF 203.0.113.9; then
    fail "$filter charged the address the forger wrote into its headers"
  fi
done
pass "a forged remote_ip, blocked marker or status frames nobody"

# Every line dated by the filter's own pattern, and dated when Caddy wrote it.
# A line whose date fail2ban cannot read is dated when fail2ban reads it — on
# a restart, every line in the file at once — and a pattern that read the
# wrong number would put failures outside the window or inside the wrong one.
now="$(date +%s)"
for filter in caddy-scanner caddy-errors; do
  report="$(regex "$filter")"
  hits="$(sed -n '/^Date template hits:/,/^`-/s/^|  \[\([0-9]*\)\].*/\1/p' <<<"$report" | head -1)"
  [[ "$hits" == "$lines" ]] \
    || fail "$filter's date pattern read ${hits:-none} of $lines timestamps:
$report"
  # `--out row` prints [address, time, ...] for each matched line.
  while read -r stamp; do
    (( stamp >= STARTED && stamp <= now )) \
      || fail "$filter dated a line $stamp, outside the $STARTED-$now the traffic was sent in"
  done < <(regex "$filter" --out row | sed -n "s/^\['[^']*',[[:space:]]*\([0-9]*\)[.0-9]*,.*/\1/p")
done
pass "both filters read every timestamp Caddy wrote"

echo "==> Ban filter check passed"
