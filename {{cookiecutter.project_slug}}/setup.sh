#!/usr/bin/env bash
# Walks a human through setting up {{ cookiecutter.project_name }} after
# `cookiecutter` generates the project. Run it from the project root:
#
#   ./setup.sh
#
# This first checks that the tools the rest of setup depends on are present
# and working — Node.js and Docker — before anything destructive (writing
# env files, installing dependencies, starting containers) happens. It then
# writes the env files, generates a NEXTAUTH_SECRET, prompts for credentials
# for whichever optional features (Stripe, OAuth providers, Resend, the
# configured LLM provider) actually survived generation, installs
# dependencies, brings up the Docker Compose services, and generates and
# applies database migrations.
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

# ─── Feature credentials ───────────────────────────────────────────────────
# post_gen_project.py already stripped the cc:begin/cc:end marker regions
# (and, for Stripe/magic link, deleted whole files) for anything answered
# "no" at generation time — and cookiecutter.json's answers don't ship with
# the generated project at all. So which optional features are actually in
# play has to be read back out of what survived generation: which KEY= lines
# are present in .env.local (copied from .env.example by setup_env_files
# above) and, for Stripe, whether lib/stripe.ts survived handle_stripe().

# Prints "KEY=value" line VALUE for KEY in FILE, or "" if missing/blank.
# `|| true` keeps `grep -E` finding no match (exit 1) from tripping `set -e`
# under `pipefail`, since grep is the leftmost — not last — command here.
env_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || { printf ''; return; }
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d'=' -f2- || true
}

# Escapes a value for safe use as a `sed s#...#VALUE#` replacement (backslash,
# ampersand, and the `#` delimiter itself all need escaping).
sed_escape_replacement() {
  printf '%s' "$1" | sed -e 's/[\&#]/\\&/g'
}

# Writes VALUE into KEY='s line in .env.local and .env.docker.local, but only
# where that line is still blank — same idempotence guard as
# setup_nextauth_secret, so a value a user already filled in (by hand, or on
# an earlier run of this script) is never clobbered. Stripe/OAuth/Resend/LLM
# secrets are plain values, not addressing details, so unlike
# DATABASE_URL/REDIS_URL they're identical in both files.
set_env_value() {
  local key="$1" value="$2" escaped f
  escaped="$(sed_escape_replacement "$value")"
  for f in .env.local .env.docker.local; do
    [[ -f "$f" ]] || continue
    if grep -qE "^${key}=[[:space:]]*$" "$f"; then
      sed -i.bak "s#^${key}=.*#${key}=${escaped}#" "$f" ||
        die "Failed to write ${key} to ${f}."
      rm -f "${f}.bak"
    fi
  done
}

# Prompts for KEY (with PROMPT_TEXT) unless it's already non-blank in
# .env.local. Pressing enter with no input leaves it blank and moves on —
# these are setup conveniences, not hard requirements, so nothing here dies.
prompt_for_credential() {
  local key="$1" prompt_text="$2" value=""
  if [[ -n "$(env_value "$key" .env.local)" ]]; then
    echo "${key} is already set — leaving it as is."
    return
  fi
  read -rp "$prompt_text" value || true
  if [[ -z "$value" ]]; then
    echo "Skipping ${key} for now — fill it into .env.local and .env.docker.local whenever you're ready."
    return
  fi
  set_env_value "$key" "$value"
  success "${key} saved."
}

# Ollama needs no API key, but it does need to actually be running somewhere
# this project can reach. OLLAMA_BASE_URL ships pointed at Ollama's
# OpenAI-compatible endpoint (".../v1"), but its native API
# (".../api/tags", no "/v1") is the more reliable liveness probe: a plain
# unauthenticated GET that answers "is Ollama even up" without implying
# anything about which models are pulled. Unreachable is a warning, not a
# die() — the user may well start Ollama after setup finishes.
check_ollama_reachable() {
  local base_url native_url model
  base_url="$(env_value OLLAMA_BASE_URL .env.local)"
  base_url="${base_url:-http://localhost:11434/v1}"
  native_url="${base_url%/v1}/api/tags"
  model="$(env_value OLLAMA_MODEL .env.local)"
  model="${model:-llama3.2}"

  info "Checking for a local Ollama instance at ${base_url}..."

  if curl -sf --max-time 3 "$native_url" >/dev/null 2>&1; then
    success "Ollama is reachable at ${base_url}."
  else
    cat <<EOF

⚠ Could not reach Ollama at ${base_url}.

This project is configured to use a local Ollama instance as its LLM
provider — no API key is needed, but Ollama itself needs to be installed
and running before the app can call it.

  Install:      https://ollama.com/download
  Start:        ollama serve   (or just open the Ollama app)
  Pull a model: ollama pull ${model}

This isn't a failure: install/start Ollama whenever you're ready and the
app will be able to reach it — no need to re-run ./setup.sh just for this.
EOF
  fi
}

# For the LLM provider actually configured (exactly one survives in
# .env.local per post_gen_project.py's llm-<name> markers), prompts for its
# API key — except Ollama, which gets a reachability check instead.
setup_llm_credentials() {
  local provider
  provider="$(env_value LLM_PROVIDER .env.local)"

  case "$provider" in
    ollama)
      check_ollama_reachable
      ;;
    openai)
      echo
      echo "OpenAI is this project's configured LLM provider."
      echo "Get an API key at: https://platform.openai.com/api-keys"
      prompt_for_credential OPENAI_API_KEY "OpenAI API key: "
      ;;
    anthropic)
      echo
      echo "Anthropic is this project's configured LLM provider."
      echo "Get an API key at: https://console.anthropic.com/settings/keys"
      prompt_for_credential ANTHROPIC_API_KEY "Anthropic API key: "
      ;;
    openrouter)
      echo
      echo "OpenRouter is this project's configured LLM provider."
      echo "Get an API key at: https://openrouter.ai/keys"
      prompt_for_credential OPENROUTER_API_KEY "OpenRouter API key: "
      ;;
    *)
      echo "Unrecognized LLM_PROVIDER '${provider}' in .env.local — skipping LLM credential setup."
      ;;
  esac
}

setup_feature_credentials() {
  info "Checking for optional features that need credentials..."

  # Stripe: unlike the other features, .env.example never marks its keys
  # with cc:begin/cc:end (they're always there), so lib/stripe.ts surviving
  # handle_stripe()'s removal is the actual signal that include_stripe=yes.
  if [[ -f lib/stripe.ts ]]; then
    echo
    echo "Stripe is enabled for this project. You'll need:"
    echo "  - STRIPE_SECRET_KEY    : API keys page      -> https://dashboard.stripe.com/apikeys"
    echo "  - STRIPE_WEBHOOK_SECRET: a webhook endpoint's signing secret -> https://dashboard.stripe.com/webhooks"
    echo "    (endpoint /api/webhook/stripe; events checkout.session.completed,"
    echo "    checkout.session.async_payment_succeeded, checkout.session.async_payment_failed,"
    echo "    customer.subscription.updated, customer.subscription.deleted)"
    prompt_for_credential STRIPE_SECRET_KEY "Stripe secret key (sk_...): "
    prompt_for_credential STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret (whsec_...): "
  fi

  if grep -qE '^GOOGLE_ID=' .env.local; then
    echo
    echo "Google OAuth is enabled for this project. Create credentials at:"
    echo "  https://console.cloud.google.com/apis/credentials"
    prompt_for_credential GOOGLE_ID "Google OAuth client ID: "
    prompt_for_credential GOOGLE_SECRET "Google OAuth client secret: "
  fi

  if grep -qE '^MICROSOFT_ENTRA_ID_ID=' .env.local; then
    echo
    echo "Microsoft Entra ID (Azure AD) OAuth is enabled. Register an app at:"
    echo "  https://portal.azure.com/ -> Microsoft Entra ID -> App registrations"
    prompt_for_credential MICROSOFT_ENTRA_ID_ID "Microsoft Entra ID application (client) ID: "
    prompt_for_credential MICROSOFT_ENTRA_ID_SECRET "Microsoft Entra ID client secret: "
    prompt_for_credential MICROSOFT_ENTRA_ID_TENANT_ID "Microsoft Entra ID tenant ID: "
  fi

  # RESEND_API_KEY survives for magic-link sign-in, the contact form OR the
  # subscription acknowledgment (post_gen_project.py's "resend" marker is
  # `magic_link or extras or stripe`), so it doesn't by itself say which —
  # the prompt below covers all three.
  if grep -qE '^RESEND_API_KEY=' .env.local; then
    echo
    echo "Resend is enabled (used for magic-link sign-in, the contact form and/or subscription acknowledgment emails)."
    echo "Get an API key at: https://resend.com/api-keys"
    prompt_for_credential RESEND_API_KEY "Resend API key: "
  fi

  setup_llm_credentials
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
  # Prompting for feature credentials before npm ci/docker compose (rather
  # than after) means any typing happens up front, not interleaved with the
  # install/container-startup wait — #65 doesn't mandate the ordering, this
  # is just pacing.
  setup_feature_credentials
  install_dependencies
  start_containers
  run_migrations

  print_ready_summary
}

main "$@"
