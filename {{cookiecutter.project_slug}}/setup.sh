#!/usr/bin/env bash
# Walks a human through setting up {{ cookiecutter.project_name }} after
# `cookiecutter` generates the project. Run it from the project root:
#
#   ./setup.sh
#
# This first checks that the tools the rest of setup depends on are present
# and working — Node.js and Docker — before anything destructive (writing
# env files, installing dependencies, starting containers) happens. Later
# tickets (#63, #64, #65) layer the env-file, `npm ci`, `docker compose`,
# migration, and conditional-credentials steps on top of this; for now, a
# clean prerequisite check is the whole script.
set -euo pipefail

REQUIRED_NODE_MAJOR="{{ cookiecutter.node_version }}"

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

main() {
  info "Setting up {{ cookiecutter.project_name }}"
  echo "This script checks that the tools this project needs are installed"
  echo "and running before touching anything in your project directory."

  check_node
  check_docker

  echo
  success "All prerequisites look good!"
  echo "{{ cookiecutter.project_name }} is ready for the next setup steps."
}

main "$@"
