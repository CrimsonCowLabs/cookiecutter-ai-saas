#!/usr/bin/env bash
set -e

# The account ansible/provision.yml creates on the host. Both names come from
# one place at generation time, so deploys land on the account provisioning made.
VPS_USER="__DEPLOY_USER__"
# The same host as ansible/inventory.ini.
VPS_HOST="YOUR_VPS_IP"
VPS_PATH="/app/{{ cookiecutter.project_slug }}"

ALL_TARGETS="app worker db-writer migrator ops"

usage() {
  echo "Usage: ./scripts/deploy.sh <mode|target> [targets...]"
  echo ""
  echo "Modes:"
  echo "  full                 Build and deploy all images"
  echo "  env                  Sync env files only (no build)"
  echo ""
  echo "Targets (one or more, space-separated):"
  echo "  app worker db-writer migrator ops"
  echo ""
  echo "Examples:"
  echo "  ./scripts/deploy.sh full                  # Build & deploy everything"
  echo "  ./scripts/deploy.sh app                   # Build & deploy app only"
  echo "  ./scripts/deploy.sh worker db-writer      # Build & deploy worker + db-writer"
  echo "  ./scripts/deploy.sh env                   # Sync .env-production only"
  exit 1
}

image_for() {
  case "$1" in
    app)        echo "{{ cookiecutter.project_slug }}-app:latest" ;;
    worker)     echo "{{ cookiecutter.project_slug }}-worker:latest" ;;
    db-writer)  echo "{{ cookiecutter.project_slug }}-db-writer:latest" ;;
    migrator)   echo "{{ cookiecutter.project_slug }}-migrator:latest" ;;
    ops)        echo "{{ cookiecutter.project_slug }}-ops:latest" ;;
    *)          echo ""; return 1 ;;
  esac
}

build_image() {
  local img
  img=$(image_for "$1")
  case "$1" in
    app)        docker build --platform linux/amd64 -t "$img" --target runner -f Dockerfile . ;;
    worker)     docker build --platform linux/amd64 -t "$img" -f workers/Dockerfile.worker ./workers ;;
    db-writer)  docker build --platform linux/amd64 -t "$img" -f workers/db-writer/Dockerfile.writer . ;;
    migrator)   docker build --platform linux/amd64 -t "$img" --target migrator -f Dockerfile . ;;
    ops)        docker build --platform linux/amd64 -t "$img" --target ops -f Dockerfile . ;;
  esac
}

MODE="{% raw %}${1:-}{% endraw %}"
if [ -z "$MODE" ]; then
  usage
fi

# ── Env-only mode ──
if [ "$MODE" = "env" ]; then
  echo "==> Syncing env files only (no image build)..."
  rsync -avz .env-production {% raw %}${VPS_USER}@${VPS_HOST}:${VPS_PATH}{% endraw %}/.env-production

  echo "==> Restarting containers to pick up env changes..."
  ssh {% raw %}${VPS_USER}@${VPS_HOST}{% endraw %} "cd {% raw %}${VPS_PATH}{% endraw %} && docker compose -f docker-compose.prod.yml --env-file .env-production up -d"

  echo "==> Env-only update complete!"
  exit 0
fi

# ── Determine which images to build ──
TARGETS=""

if [ "$MODE" = "full" ]; then
  TARGETS="$ALL_TARGETS"
else
  for arg in "$@"; do
    if ! image_for "$arg" > /dev/null 2>&1; then
      echo "Error: unknown target '$arg'"
      echo "Valid targets: $ALL_TARGETS"
      exit 1
    fi
    TARGETS="$TARGETS $arg"
  done
fi

TARGETS=$(echo "$TARGETS" | xargs)

if [ -z "$TARGETS" ]; then
  usage
fi

echo "==> Targets: $TARGETS"

# ── Build ──
echo "==> Building images locally (linux/amd64)..."
for target in $TARGETS; do
  echo "  Building {% raw %}${target}{% endraw %}..."
  build_image "$target"
done

# ── Save & transfer ──
IMAGE_LIST=""
for target in $TARGETS; do
  IMAGE_LIST="$IMAGE_LIST $(image_for "$target")"
done

echo "==> Saving images to tarball..."
docker save $IMAGE_LIST | gzip > /tmp/{{ cookiecutter.project_slug }}-images.tar.gz

echo "==> Transferring images to VPS..."
scp /tmp/{{ cookiecutter.project_slug }}-images.tar.gz {% raw %}${VPS_USER}@${VPS_HOST}{% endraw %}:/tmp/{{ cookiecutter.project_slug }}-images.tar.gz

echo "==> Loading images on VPS..."
ssh {% raw %}${VPS_USER}@${VPS_HOST}{% endraw %} "gunzip -c /tmp/{{ cookiecutter.project_slug }}-images.tar.gz | docker load && rm /tmp/{{ cookiecutter.project_slug }}-images.tar.gz"

echo "==> Syncing config files to VPS..."
rsync -avz --delete \
  --exclude='node_modules' --exclude='.next' --exclude='.git' \
  ./ {% raw %}${VPS_USER}@${VPS_HOST}:${VPS_PATH}{% endraw %}/

echo "==> Copying production env file..."
rsync -avz .env-production {% raw %}${VPS_USER}@${VPS_HOST}:${VPS_PATH}{% endraw %}/.env-production

echo "==> Starting containers..."
ssh {% raw %}${VPS_USER}@${VPS_HOST}{% endraw %} "cd {% raw %}${VPS_PATH}{% endraw %} && docker compose -f docker-compose.prod.yml --env-file .env-production up -d"

# ── Run migrations if migrator was included ──
for target in $TARGETS; do
  if [ "$target" = "migrator" ]; then
    echo "==> Running database migrations..."
    ssh {% raw %}${VPS_USER}@${VPS_HOST}{% endraw %} "cd {% raw %}${VPS_PATH}{% endraw %} && docker run --rm --env-file .env-production --network {{ cookiecutter.project_slug }}_default $(image_for migrator)"
    break
  fi
done

echo "==> Cleaning up local tarball..."
rm /tmp/{{ cookiecutter.project_slug }}-images.tar.gz

echo "==> Deployment complete! ($TARGETS)"
