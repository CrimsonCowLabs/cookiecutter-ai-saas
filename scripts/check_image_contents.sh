#!/usr/bin/env bash
# Prove that local secrets and the host's node_modules never enter a built
# image (issue #105).
#
# Usage: scripts/check_image_contents.sh <generated-project-dir>
#
# Every image is built from a directory on the machine that deploys, and that
# directory is where the secrets live: the env files a deploy renders, the
# vault password, a vault somebody decrypted to read, the operator's own .env.
# The Dockerfile's builder stage runs `COPY . .`, so whatever the build context
# holds is in that stage — and `next build` loads .env and .env.production
# from it and Next's standalone output copies them on into the runner image.
# The host's node_modules would land on top of the frozen `npm ci` install the
# same way, so the image would run whatever the host happened to have
# installed. The .dockerignore beside each build context is what stops all of
# it; this proves it does.
#
# So this plants each of those files in the project, every one holding a
# string that appears nowhere else, plus a fake package in each node_modules
# a build could pick up. It then builds every image ansible/deploy.yml ships
# (read out of its `deploy_images` map, so an image added there is checked
# here too, or this fails for want of expectations for it), with the same
# `docker build` invocation the deploy uses, and reads each image's whole
# filesystem through `docker export`. An image fails if any planted path is in
# it, or if any file in it contains a planted string — which is what catches a
# secret copied under another name, as Next's standalone output does. The
# builder stage is checked as well although it never ships: it is where
# `COPY . .` lands, so it is where the host's node_modules would overwrite
# npm's.
#
# Absence alone would pass an image with no node_modules at all, so each image
# that runs Node must also hold a real dependency where `npm ci` puts it.
#
# The images are tagged :image-check rather than :latest, so a check run in a
# project that also deploys never replaces the images a deploy would ship.
# Everything planted is removed again on exit; the check refuses to start if
# any of it already exists rather than overwrite a real secret.
#
# Needs docker and python3 with PyYAML (cookiecutter depends on it).
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

PROJECT_DIR="${1:?usage: check_image_contents.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

SLUG="$(basename "$PWD")"
PLATFORM="$(sed -n 's/^deploy_platform: *//p' ansible/group_vars/all.yml | head -1)"
[[ -n "$PLATFORM" ]] || fail "could not read deploy_platform out of ansible/group_vars/all.yml"

# One random token per run, so a string left over from an earlier run or
# present in some upstream package cannot be mistaken for a leak, or hide one.
TOKEN="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
SENTINEL="image-leak-sentinel-$TOKEN"

# Every file this plants, relative to the project root. The env files are the
# operator's own (.env, .env.local, .env.production — the last is what Next
# loads for `next build`), and the ones ansible/deploy.yml renders on the
# control machine (.env-production, .env-app). The vault password lives at
# either path --vault-password-file is pointed at, and ansible/vault.yml
# stands in for a vault left decrypted. The worker's context is workers/, so
# its own .env is planted inside it too.
PLANTED_FILES=(
  .env
  .env.local
  .env.production
  .env-production
  .env-app
  .vault-pass
  ansible/.vault-pass
  ansible/vault.yml
  deploy-key.pem
  workers/.env
  workers/app/.env
  workers/db-writer/.env
)
# A package in each node_modules a build context contains. Its basename is
# what the images are searched for.
MARKER=host-planted-marker
PLANTED_PACKAGES=(
  "node_modules/$MARKER"
  "workers/db-writer/node_modules/$MARKER"
)

for f in "${PLANTED_FILES[@]}" "${PLANTED_PACKAGES[@]}"; do
  if [[ -e "$f" ]]; then
    fail "$PWD/$f exists; this check would overwrite it. Run it against a freshly generated project."
  fi
done

# node_modules directories this created, as opposed to found, so cleanup
# removes them and not an install the project already had.
CREATED_DIRS=()
CONTAINERS=()
IMAGES=()
cleanup() {
  echo "==> Removing planted files, containers and images"
  rm -f "${PLANTED_FILES[@]}"
  rm -rf "${PLANTED_PACKAGES[@]}"
  if ((${#CREATED_DIRS[@]})); then rm -rf "${CREATED_DIRS[@]}"; fi
  if ((${#CONTAINERS[@]})); then docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true; fi
  if ((${#IMAGES[@]})); then docker rmi "${IMAGES[@]}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "==> Planting secrets and host packages (sentinel $SENTINEL)"
for f in "${PLANTED_FILES[@]}"; do
  printf 'PLANTED_SECRET=%s:%s\n' "$SENTINEL" "$f" > "$f"
done
for p in "${PLANTED_PACKAGES[@]}"; do
  modules="$(dirname "$p")"
  if [[ ! -d "$modules" ]]; then CREATED_DIRS+=("$modules"); fi
  mkdir -p "$p"
  printf '{"name": "%s", "version": "0.0.0", "description": "%s:%s"}\n' \
    "$MARKER" "$SENTINEL" "$p" > "$p/package.json"
done

# What each image is built from, exactly as deploy.yml has it: name, then
# Dockerfile, context and target (empty for a one-stage Dockerfile), one image
# per line. The builder stage is appended: it never ships, but it is where the
# build context is copied.
mapfile -t BUILDS < <(python3 - ansible/deploy.yml <<'PY'
import sys
import yaml


def find(node):
    if isinstance(node, dict):
        if "deploy_images" in node:
            return node["deploy_images"]
        node = list(node.values())
    if isinstance(node, list):
        for child in node:
            found = find(child)
            if found:
                return found
    return None


images = find(yaml.safe_load(open(sys.argv[1])))
if not images:
    sys.exit("no deploy_images map in " + sys.argv[1])
images = dict(images, builder={"dockerfile": "Dockerfile", "context": ".", "target": "builder"})
for name, spec in images.items():
    print("\t".join([name, spec["dockerfile"], spec["context"], spec.get("target", "")]))
PY
)
((${#BUILDS[@]})) || fail "read no images out of ansible/deploy.yml"

# What each image must hold. The path is inside the image's filesystem, and
# for every image that runs Node it is a real dependency installed by `npm
# ci`: alongside the planted package's absence, that is what shows the
# image's node_modules is npm's and not the host's.
declare -A REQUIRED=(
  [builder]="app/node_modules/next/package.json"
  [app]="app/node_modules/next/package.json"
  [ops]="app/node_modules/next/package.json"
  [migrator]="app/node_modules/drizzle-kit/package.json"
  [db-writer]="app/node_modules/ioredis/package.json"
  [worker]="app/worker.py"
  [caddy]="usr/bin/caddy"
)

# Reads an image's filesystem as a tar stream on stdin. Prints one line per
# problem, naming the path; prints nothing for a clean image.
SCAN_PY='
import os, sys, tarfile

sentinel, marker, required = sys.argv[1].encode(), sys.argv[2], sys.argv[3]
planted = set(os.path.basename(p) for p in sys.argv[4:])
seen_required = False
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
    for member in tar:
        path = member.name.removeprefix("./").lstrip("/")
        if path == required:
            seen_required = True
        parts = path.split("/")
        if marker in parts:
            print("host package %s is in the image: /%s" % (marker, path))
        # A planted name under /app outside node_modules is the planted file,
        # whatever it holds. Inside node_modules a package may ship its own
        # .env.example and the like; the content check below still covers it.
        elif parts[0] == "app" and "node_modules" not in parts and parts[-1] in planted:
            print("planted file %s is in the image: /%s" % (parts[-1], path))
        if member.isfile():
            data = tar.extractfile(member).read()
            if sentinel in data:
                print("a planted secret is in the contents of /%s" % path)
if not seen_required:
    print("/%s is missing, so this image has no install of its own" % required)
'

# Every image is checked before failing, so one run names every leak.
FAILED=()
for line in "${BUILDS[@]}"; do
  IFS=$'\t' read -r name dockerfile context target <<<"$line"
  required="${REQUIRED[$name]:-}"
  [[ -n "$required" ]] \
    || fail "deploy.yml ships an image '$name' this check has no expectations for; add it to REQUIRED"
  image="$SLUG-$name:image-check"
  IMAGES+=("$image")

  echo "==> Building $name ($dockerfile${target:+, target $target}, context $context)"
  # deploy.yml's invocation, with the tag changed — see the header — and
  # --quiet, which only drops the progress output: a failing build still
  # prints why.
  docker build --quiet --platform "$PLATFORM" ${target:+--target "$target"} \
    --tag "$image" --file "$dockerfile" "$context" >/dev/null

  cid="$(docker create --platform "$PLATFORM" "$image")"
  CONTAINERS+=("$cid")
  problems="$(docker export "$cid" | python3 -c "$SCAN_PY" "$SENTINEL" "$MARKER" "$required" "${PLANTED_FILES[@]}")"
  if [[ -n "$problems" ]]; then
    echo "$problems" | sed "s|^|FAIL: $name: |" >&2
    FAILED+=("$name")
    continue
  fi
  pass "$name: no planted secret or host package, and /$required is present"
done

if ((${#FAILED[@]})); then
  fail "these images hold what they must not: ${FAILED[*]}. Each needs a .dockerignore in its build context that excludes it."
fi
echo "==> Image contents check passed"
