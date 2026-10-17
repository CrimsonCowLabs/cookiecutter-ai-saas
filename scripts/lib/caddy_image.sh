#!/usr/bin/env bash
# The generated project's own Caddy image, built from its caddy/ directory.
#
# Sourced by scripts/check_caddyfile.sh, scripts/check_caddy_edge.sh and
# scripts/check_ban_filters.sh. Production does not run stock Caddy: it runs a
# build with the rate-limit module compiled in (caddy/Dockerfile, issue #100),
# and a Caddyfile using `rate_limit` is a syntax error to any other build. So
# every check that hands the Caddyfile to Caddy hands it to this one.
#
# Usage:
#
#     source "$(dirname "$0")/lib/caddy_image.sh"
#     IMAGE="$(caddy_image_build <generated-project-dir>)"
#
# The tag is derived from the Dockerfile's contents, so a rebuild of the same
# Dockerfile is a cache hit under the same name rather than another dangling
# image, and two projects whose Dockerfiles differ never share a tag.

# caddy_image_build PROJECT_DIR: builds PROJECT_DIR/caddy and prints the tag.
caddy_image_build() {
  local context="${1:?caddy_image_build needs a project directory}/caddy"
  [[ -f "$context/Dockerfile" ]] || {
    echo "FAIL: no Caddy Dockerfile at $context/Dockerfile" >&2
    return 1
  }
  local tag
  tag="check-caddy:$(sha256sum "$context/Dockerfile" | cut -c1-12)"
  # Build output goes to stderr, so a caller capturing the tag sees only it,
  # and a failing build still shows why.
  docker build -q -t "$tag" "$context" >/dev/null || {
    echo "FAIL: could not build the Caddy image from $context" >&2
    return 1
  }
  echo "$tag"
}
