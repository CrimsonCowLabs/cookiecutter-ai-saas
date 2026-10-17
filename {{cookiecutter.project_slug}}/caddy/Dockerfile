# Caddy with the rate-limit module compiled in.
#
# Stock Caddy has no rate limiter, and its modules are compiled in rather than
# loaded, so the Caddyfile's `rate_limit` directive needs a build of its own:
# xcaddy in Caddy's builder image compiles Caddy with
# github.com/mholt/caddy-ratelimit, and the binary replaces the one in the
# matching runtime image. Everything else — the entrypoint, the config at
# /etc/caddy/Caddyfile, /data and /config — is the stock image's.
#
# Both are pinned exactly. Caddy's version is the one ARG below, which both
# stages read, so the builder and the runtime image cannot drift apart: a
# builder newer than its runtime image would mean the binary and the image it
# runs in describe different releases. The module has no tagged release past
# v0.1.0 (2022), so it is pinned to a commit by Go pseudo-version, which go.sum
# then checks by hash. To upgrade, change the ARG and the module's pin below
# and run scripts/check_caddyfile.sh and scripts/check_caddy_edge.sh against a
# generated project.
ARG CADDY_VERSION=2.11.7

FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
