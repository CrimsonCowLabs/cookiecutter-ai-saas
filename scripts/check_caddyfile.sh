#!/usr/bin/env bash
# Check one generated Caddyfile: that generation left nothing behind, and that
# Caddy itself accepts the result.
#
# Usage: scripts/check_caddyfile.sh <path-to-generated-Caddyfile>
#
# Only what holds for every set of answers belongs here. Assertions about a
# particular answer — which domain, whether an ACME address was emitted — belong
# with the caller that chose those answers.
set -euo pipefail

CADDYFILE="${1:?usage: check_caddyfile.sh <path-to-generated-Caddyfile>}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$CADDYFILE" ]] || fail "no such file: $CADDYFILE"

# A surviving Jinja tag is a Caddy syntax error that would not surface until the
# first deploy.
! grep -qE '\{%|\{\{' "$CADDYFILE" \
  || fail "unrendered Jinja in $CADDYFILE: $(grep -nE '\{%|\{\{' "$CADDYFILE" | head -3)"

# Every request has to reach the app through the proxy — on the host's loopback,
# where the app publishes its port, because Caddy runs on the host's network
# and has no compose service names to resolve.
grep -q '^[[:space:]]*reverse_proxy 127.0.0.1:3000$' "$CADDYFILE" \
  || fail "$CADDYFILE does not reverse_proxy to 127.0.0.1:3000"

# Every client is rate-limited per address at the edge (issue #100), with each
# limit read from the environment so it can be tuned without editing this file.
for var in CADDY_RATE_LIMIT_EVENTS CADDY_RATE_LIMIT_WINDOW \
  CADDY_STRICT_RATE_LIMIT_EVENTS CADDY_STRICT_RATE_LIMIT_WINDOW; do
  grep -qF "{\$$var:" "$CADDYFILE" \
    || fail "$CADDYFILE does not read \$$var (with a default) for its rate limits"
done

# Caddy needs the file at a path inside the container, so mount it absolute.
# The image is the project's own build (caddy/Dockerfile beside the
# Caddyfile), not stock Caddy: stock Caddy has no rate_limit directive, so it
# would reject this file — and accepting it is what production depends on.
PROJECT_DIR="$(cd "$(dirname "$CADDYFILE")" && pwd)"
ABS="$PROJECT_DIR/$(basename "$CADDYFILE")"
# shellcheck source=lib/caddy_image.sh
source "$(dirname "$0")/lib/caddy_image.sh"
IMAGE="$(caddy_image_build "$PROJECT_DIR")" || fail "no Caddy image for $PROJECT_DIR"
RUN=(docker run --rm -v "$ABS:/etc/caddy/Caddyfile:ro" "$IMAGE")

"${RUN[@]}" caddy list-modules | grep -qx 'http.handlers.rate_limit' \
  || fail "$IMAGE was built without the rate-limit module"

# Caddy logs "input is not formatted" on every boot otherwise. The warning is
# easy to reintroduce, because it is Jinja whitespace that decides it.
"${RUN[@]}" caddy fmt /etc/caddy/Caddyfile | diff -u "$CADDYFILE" - \
  || fail "$CADDYFILE is not what \`caddy fmt\` produces (diff above)"

"${RUN[@]}" caddy validate --config /etc/caddy/Caddyfile \
  || fail "Caddy rejected $CADDYFILE"

echo "ok: $CADDYFILE is fully rendered, formatted and valid"
