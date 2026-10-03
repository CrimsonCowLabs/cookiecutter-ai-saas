#!/usr/bin/env bash
# Walks a human through setting up {{ cookiecutter.project_name }} after
# `cookiecutter` generates the project. Run it from the project root:
#
#   ./setup.sh
#
# This first checks that the tools the rest of setup depends on are present
# and working — Node.js and Docker — before anything destructive (writing
# env files, installing dependencies, starting containers) happens. It then
# writes the env files, generates a NEXTAUTH_SECRET, installs dependencies,
# brings up the Docker Compose services, and generates and applies database
# migrations. A later ticket (#65) layers conditional-credential prompting on
# top of this.
set -euo pipefail

REQUIRED_NODE_MAJOR="{{ cookiecutter.node_version }}"
POSTGRES_PORT="{{ cookiecutter.postgres_port }}"
REDIS_PORT="{{ cookiecutter.redis_port }}"

# How long to wait for Docker Compose services to report healthy before
# giving up (seconds). Generous because the first run also has to build the
# app/worker/db-writer images, which depends_on: condition: service_healthy
# already waits out before these containers even start.
HEALTH_TIMEOUT="${SETUP_HEALTH_TIMEOUT:-180}"
HEALTH_POLL_INTERVAL=3

info()    { printf '\n==> %s\n' "$*"; }
success() { printf '✔ %s\n' "$*"; }
die()     { printf '\n✘ %s\n' "$*" >&2; exit 1; }

# ─── Node.js ──────────────────────────────────────────────────────────────
check_node() {
  info "Checking for Node.js >= ${REQUIRED_NODE_MAJOR}..."

  if ! command -v node >/dev/null 2>&1; then
    die "Node.js is not installed. Install Node.js ${REQUIRED_NODE_MAJOR} or newer from https://nodejs.org/ (or via nvm/fnm) and re-run ./setup.sh."
  fi

  local node_version installed_major
  node_version="$(node -v)"                       # e.g. v20.11.1
  installed_major="${node_version#v}"
  installed_major="${installed_major%%.*}"

  if [[ "$installed_major" -lt "$REQUIRED_NODE_MAJOR" ]]; then
    die "Node.js ${node_version} is installed, but this project needs Node.js ${REQUIRED_NODE_MAJOR} or newer. Install a newer version (https://nodejs.org/, or nvm/fnm) and re-run ./setup.sh."
  fi

  success "Node.js ${node_version} meets the required major version (>= ${REQUIRED_NODE_MAJOR})."
}

# ─── Docker ───────────────────────────────────────────────────────────────
docker_install_instructions() {
  case "$(uname -s)" in
    Darwin)
      cat <<'EOF'
Docker is not installed.

  macOS: install Docker Desktop
    https://www.docker.com/products/docker-desktop/
  (or: brew install --cask docker)

Once installed, open Docker Desktop and wait for it to finish starting,
then re-run ./setup.sh.
EOF
      ;;
    Linux)
      cat <<'EOF'
Docker is not installed.

  Linux: install Docker Engine
    https://docs.docker.com/engine/install/
  (Docker Desktop for Linux is also available:
    https://www.docker.com/products/docker-desktop/)

After installing, make sure the Docker daemon is running (e.g.
`sudo systemctl start docker` on most distros), then re-run ./setup.sh.
EOF
      ;;
    MINGW*|MSYS*|CYGWIN*)
      cat <<'EOF'
Docker is not installed.

  Windows: install Docker Desktop
    https://www.docker.com/products/docker-desktop/

Once installed, start Docker Desktop and wait for it to finish starting,
then re-run ./setup.sh.
EOF
      ;;
    *)
      cat <<'EOF'
Docker is not installed.

  Install Docker Desktop (macOS/Windows) or Docker Engine (Linux):
    https://www.docker.com/products/docker-desktop/
    https://docs.docker.com/engine/install/

Once installed and running, re-run ./setup.sh.
EOF
      ;;
  esac
}

docker_not_running_instructions() {
  case "$(uname -s)" in
    Darwin)
      cat <<'EOF'
Docker is installed, but the daemon is not running.

  macOS: open the Docker Desktop app from Launchpad/Spotlight and wait for
  the whale icon in the menu bar to show Docker is running.

Then re-run ./setup.sh.
EOF
      ;;
    Linux)
      cat <<'EOF'
Docker is installed, but the daemon is not running.

  Linux: start the Docker service, e.g.:
    sudo systemctl start docker

  If you're using Docker Desktop for Linux, open it from your applications
  menu and wait for it to finish starting.

Then re-run ./setup.sh.
EOF
      ;;
    MINGW*|MSYS*|CYGWIN*)
      cat <<'EOF'
Docker is installed, but the daemon is not running.

  Windows: open Docker Desktop from the Start menu and wait for it to
  finish starting (the whale icon in the system tray will show it's ready).

Then re-run ./setup.sh.
EOF
      ;;
    *)
      cat <<'EOF'
Docker is installed, but the daemon is not running. Start Docker Desktop
(macOS/Windows) or the Docker service (Linux), then re-run ./setup.sh.
EOF
      ;;
  esac
}

check_docker() {
  info "Checking for Docker..."

  if ! command -v docker >/dev/null 2>&1; then
    docker_install_instructions
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    docker_not_running_instructions
    exit 1
  fi

  success "Docker is installed and the daemon is running."
}

# ─── Environment files ─────────────────────────────────────────────────────
# Two env files cover the two ways this project runs:
#   .env.local         host mode:      `npm run dev`, services on localhost
#   .env.docker.local  container mode: `docker compose up`, services reached
#                      by compose service name (postgres, redis)
# Both start from .env.example. Neither is ever overwritten once it exists,
# so re-running ./setup.sh never clobbers values a user has already filled in.
setup_env_files() {
  info "Setting up environment files..."

  if [[ -f .env.local ]]; then
    echo ".env.local already exists — leaving it as is."
  else
    cp .env.example .env.local
    success "Created .env.local (host mode: services on localhost)."
  fi

  if [[ -f .env.docker.local ]]; then
    echo ".env.docker.local already exists — leaving it as is."
  else
    cp .env.example .env.docker.local
    # Container mode: the app/worker/db-writer containers reach Postgres and
    # Redis by compose service name, not localhost, and always on the
    # container's own internal port — regardless of what host port
    # POSTGRES_PORT/REDIS_PORT map to.
    sed -i.bak \
      -e "s#localhost:${POSTGRES_PORT}#postgres:5432#" \
      -e "s#localhost:${REDIS_PORT}#redis:6379#" \
      .env.docker.local
    rm -f .env.docker.local.bak
    success "Created .env.docker.local (container mode: services addressed by compose service name)."
  fi
}

# ─── NEXTAUTH_SECRET ────────────────────────────────────────────────────────
generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # Fallback if openssl isn't on PATH: 32 random bytes straight from the
    # kernel's CSPRNG, hex-encoded the same way `openssl rand -hex 32` would.
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

setup_nextauth_secret() {
  info "Generating NEXTAUTH_SECRET..."

  local secret="" filled_any=0 f
  for f in .env.local .env.docker.local; do
    [[ -f "$f" ]] || continue
    if grep -qE '^NEXTAUTH_SECRET=[[:space:]]*$' "$f"; then
      if [[ -z "$secret" ]]; then
        secret="$(generate_secret)"
      fi
      sed -i.bak "s#^NEXTAUTH_SECRET=.*#NEXTAUTH_SECRET=${secret}#" "$f"
      rm -f "${f}.bak"
      filled_any=1
    fi
  done

  if [[ "$filled_any" -eq 1 ]]; then
    success "NEXTAUTH_SECRET generated and saved to .env.local and .env.docker.local."
  else
    echo "NEXTAUTH_SECRET is already set in both env files — leaving it as is."
  fi
}

# ─── Dependencies ───────────────────────────────────────────────────────────
install_dependencies() {
  info "Installing dependencies..."
  echo "Running npm ci to install exactly the versions pinned in package-lock.json."

  npm ci || die "npm ci failed. Fix the error above and re-run ./setup.sh."

  success "Dependencies installed."
}

# ─── Docker Compose ─────────────────────────────────────────────────────────
# Polls each container docker compose started until every one of them
# reports healthy (or, for a container with no healthcheck, that it's at
# least running), rather than racing ahead while Postgres/Redis are still
# starting up.
wait_for_healthy() {
  info "Waiting for services to become healthy (timeout: ${HEALTH_TIMEOUT}s)..."

  local elapsed=0
  local fmt='{% raw %}{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}{% endraw %}'

  while true; do
    local ids
    ids="$(docker compose ps -q)"

    if [[ -z "$ids" ]]; then
      die "docker compose up -d did not start any containers. Check 'docker compose ps' and 'docker compose logs'."
    fi

    local all_healthy=1
    local pending=()
    local id name status health

    for id in $ids; do
      IFS='|' read -r name status health < <(docker inspect --format "$fmt" "$id")
      name="${name#/}"

      if [[ "$health" == "n/a" ]]; then
        if [[ "$status" != "running" ]]; then
          all_healthy=0
          pending+=("${name} (${status})")
        fi
      elif [[ "$health" != "healthy" ]]; then
        all_healthy=0
        pending+=("${name} (${health})")
      fi
    done

    if [[ "$all_healthy" -eq 1 ]]; then
      success "All services are healthy."
      return 0
    fi

    if [[ "$elapsed" -ge "$HEALTH_TIMEOUT" ]]; then
      die "Timed out after ${HEALTH_TIMEOUT}s waiting for: ${pending[*]}. Check 'docker compose ps' and 'docker compose logs' for details."
    fi

    sleep "$HEALTH_POLL_INTERVAL"
    elapsed=$((elapsed + HEALTH_POLL_INTERVAL))
  done
}

start_containers() {
  info "Starting services with Docker Compose..."
  echo "This builds (on first run) and starts Postgres, Redis, and the"
  echo "app/worker/db-writer services defined in docker-compose.yml, in the"
  echo "background."

  docker compose up -d || die "docker compose up -d failed. Fix the error above and re-run ./setup.sh."

  wait_for_healthy
}

# ─── Database migrations ───────────────────────────────────────────────────
# The template ships with no committed migrations: they're generated from
# lib/db/schema.ts fresh on every setup, then applied to the Postgres
# container start_containers() just brought up. drizzle-kit migrate tracks
# which migrations it has already applied in the database itself, so
# re-running this after a successful run is a no-op rather than a
# double-apply.
run_migrations() {
  info "Generating database migrations from lib/db/schema.ts..."

  npm run db:generate || die "npm run db:generate failed. Check the error above — it usually means lib/db/schema.ts has an issue drizzle-kit couldn't resolve. Fix it and re-run ./setup.sh."

  success "Migrations generated."

  info "Applying database migrations to the Postgres container..."

  npm run db:migrate || die "npm run db:migrate failed. Make sure the postgres container is healthy (docker compose ps) and DATABASE_URL in .env.local points at it, then re-run ./setup.sh."

  success "Migrations applied."
}

# ─── Final summary ──────────────────────────────────────────────────────────
# The script stops here on purpose: dev, the Python worker, and the DB writer
# are all long-lived foreground processes, so starting any of them from this
# script would just block the terminal instead of handing control back.
print_ready_summary() {
  echo
  success "{{ cookiecutter.project_name }} is set up!"
  cat <<'EOF'

Start developing:

  npm run dev
  -> http://localhost:3000

Start the Python worker (in another terminal):

  cd workers/app && poetry install && python worker.py

Start the DB writer (in another terminal):

  npm run worker:db-writer
EOF
}

main() {
  info "Setting up {{ cookiecutter.project_name }}"
  echo "This script checks that the tools this project needs are installed"
  echo "and running before touching anything in your project directory."

  check_node
  check_docker

  echo
  success "All prerequisites look good!"

  setup_env_files
  setup_nextauth_secret
  install_dependencies
  start_containers
  run_migrations

  print_ready_summary
}

main "$@"
