#!/usr/bin/env bash
# Run the generated project's CLI (`opsctl`) against a throwaway host and
# prove the read-only verbs actually work over real SSH.
#
# Usage: scripts/check_cli.sh <generated-project-dir>
#
# The host is scripts/lib/throwaway_host.sh's — a privileged systemd container
# with a real sshd — taken to a ready state with ansible/provision.yml, the
# same way scripts/check_backups.sh does: "a provisioned host" is the state
# every one of these verbs assumes, and running the real playbook is less code
# than reimplementing a deploy account and a container runtime.
#
# The point this check is actually making is about *authentication*: opsctl
# adds no ssh flags of its own beyond what the inventory names (see
# cli/src/ssh.ts), so whatever reaches the host has to come from ssh's own
# configuration. This appends a `Host` block to the real `~/.ssh/config` for
# the duration of the check (restored on exit, whatever the outcome) — a
# stand-in for an operator adding their production host the same way, by hand
# — and the inventory names the host only by the alias that block defines,
# with no ansible_port or ansible_ssh_private_key_file at all. ssh resolves
# its own default config file from the account's home directory rather than
# $HOME, so a scratch HOME cannot stand in for this the way it can for
# everything else these checks fake; if opsctl were quietly adding its own
# `-o` options, or expected its own key, this would be the check that stops
# answering.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/throwaway_host.sh
source "$SCRIPT_DIR/lib/throwaway_host.sh"

PROJECT_DIR="${1:?usage: check_cli.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

throwaway_host_require_tools
command -v node >/dev/null || fail "node is required"
command -v npm >/dev/null || fail "npm is required"
command -v ansible-vault >/dev/null || fail "ansible-vault is required"
command -v python3 >/dev/null || fail "python3 is required (to allocate a pty for the shell check)"

if [[ -e ansible/vault.yml ]]; then
  fail "$PROJECT_DIR/ansible/vault.yml exists; this check would overwrite it. Run it against a freshly generated project."
fi

SSH_PORT=2224
HOST_ALIAS="cli-check-host"

# The real per-user ssh config, temporarily extended — see the header comment.
# Backed up and restored byte-for-byte on exit, whether or not it existed
# before, so this leaves nothing behind however the check ends.
SSH_CONFIG="$HOME/.ssh/config"
SSH_CONFIG_BACKUP=""
restore_ssh_config() {
  if [[ -n $SSH_CONFIG_BACKUP && -f $SSH_CONFIG_BACKUP ]]; then
    if [[ -s $SSH_CONFIG_BACKUP ]]; then
      cp "$SSH_CONFIG_BACKUP" "$SSH_CONFIG"
    else
      rm -f "$SSH_CONFIG"
    fi
  fi
}

trap 'restore_ssh_config; throwaway_host_stop' EXIT
throwaway_host_start "cli-check-$$" "$SSH_PORT"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
SSH_CONFIG_BACKUP="$TH_WORK/ssh-config.orig"
touch "$SSH_CONFIG_BACKUP"
[[ -f $SSH_CONFIG ]] && cp "$SSH_CONFIG" "$SSH_CONFIG_BACKUP"

VARS=ansible/group_vars/all.yml
[[ -f $VARS ]] || fail "no $VARS in $PROJECT_DIR — is this a generated project?"
read_var() { sed -n "s/^$1: *//p" "$VARS" | head -1 | tr -d '"'; }
DEPLOY_USER="$(read_var deploy_user)"
APP_DIR="$(read_var app_dir)"
SLUG="$(read_var project_slug)"
[[ -n $DEPLOY_USER && -n $APP_DIR && -n $SLUG ]] \
  || fail "could not read deploy_user/app_dir/project_slug out of $VARS"

echo "==> Building the CLI"
npm run cli:build --silent > "$TH_WORK/cli-build.log" 2>&1 \
  || { cat "$TH_WORK/cli-build.log" >&2; fail "npm run cli:build failed"; }
OPSCTL=(node "$PROJECT_DIR/cli/dist/index.js")
pass "cli/dist/index.js built"

# ── Running with no arguments lists the commands (acceptance criterion) ─────
echo "==> Running with no arguments"
help_output="$("${OPSCTL[@]}")"
for verb in config status logs shell; do
  grep -q "^  $verb" <<<"$help_output" || fail "no-args output does not list '$verb': $help_output"
done
pass "running with no arguments lists config, status, logs and shell"

echo "==> An unknown command is refused and still shows the list"
if "${OPSCTL[@]}" no-such-command >/dev/null 2>"$TH_WORK/unknown.log"; then
  fail "an unknown command exited 0"
fi
grep -q "Unknown command" "$TH_WORK/unknown.log" || fail "no message naming the unknown command"
pass "an unknown command is refused with a message and a nonzero exit"

# ── config, before anything is configured ────────────────────────────────────
# The generated inventory still has the placeholder address at this point, and
# there is no vault yet — the state a fresh clone is actually in.
echo "==> config on a freshly generated, unconfigured project"
if "${OPSCTL[@]}" config >"$TH_WORK/config-unset.log" 2>&1; then
  fail "config reported success before a host or a vault existed"
fi
grep -q "placeholder" "$TH_WORK/config-unset.log" || fail "config did not name the placeholder host"
grep -q "vault.yml not found" "$TH_WORK/config-unset.log" || fail "config did not report the missing vault"
grep -q "no host configured yet" "$TH_WORK/config-unset.log" || fail "config did not skip the SSH probe"
pass "config reports the placeholder host, the missing vault, and skips the SSH probe"

# ── Provision the throwaway host ─────────────────────────────────────────────
echo "==> Provisioning the host (ansible/provision.yml)"
ansible-playbook -i "$TH_INVENTORY" ansible/provision.yml > "$TH_WORK/provision.log" 2>&1 \
  || { tail -40 "$TH_WORK/provision.log" >&2; fail "provisioning the host failed"; }
pass "the host is provisioned: $DEPLOY_USER, Docker and $APP_DIR"

# ── An operator's ssh config, standing in for ~/.ssh/config ──────────────────
# Nothing here is opsctl's: this is what an operator adds once, by hand, the
# same way they would for any other host. opsctl only ever supplies
# `deploy_user@<ansible_host>` and, when the inventory sets them, -p/-i — none
# of which are set below, so everything about *reaching* the host (address,
# port, key, host-key trust) comes from this block alone.
cat >> "$SSH_CONFIG" <<SSHCONFIG

Host $HOST_ALIAS
  HostName 127.0.0.1
  Port $SSH_PORT
  User $DEPLOY_USER
  IdentityFile $TH_KEY
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $TH_WORK/known_hosts
SSHCONFIG

# ── Point the generated project at the throwaway host ────────────────────────
# Only the alias goes in the inventory — no ansible_port, no
# ansible_ssh_private_key_file. Ansible itself still needs those two (it never
# reads ~/.ssh/config's Port/IdentityFile the way plain ssh does), so this
# inventory is deliberately not the one ansible-playbook uses above; opsctl
# reads the same file either way.
cat > ansible/inventory.ini <<INVENTORY
[vps]
$HOST_ALIAS ansible_host=$HOST_ALIAS
INVENTORY

printf 'cli-check-vault-password\n' > "$TH_WORK/vault-pass"
cat > ansible/vault.yml <<VAULTFILE
---
vault_nextauth_secret: "cli-check-sentinel"
VAULTFILE
ansible-vault encrypt --vault-password-file "$TH_WORK/vault-pass" ansible/vault.yml >/dev/null

echo "==> config once a host and an encrypted vault exist"
config_output="$("${OPSCTL[@]}" config 2>&1)" || true
echo "$config_output"
for name in inventory vault ssh; do
  grep -qE "^\[ok\][[:space:]]+$name:" <<<"$config_output" \
    || fail "config did not report '$name' as ok (see output above)"
done
pass "config reports the inventory, the vault and SSH reachability as ok — using only ~/.ssh/config"

# ── Bring up two services on the host to have something real to observe ─────
# Postgres and Redis are pre-built public images — no app image needs building
# for this check, which is only about opsctl's own verbs.
echo "==> Bringing up postgres and redis on the host"
docker cp docker-compose.prod.yml "$TH_NAME:$APP_DIR/docker-compose.prod.yml" >/dev/null
docker cp Caddyfile "$TH_NAME:$APP_DIR/Caddyfile" >/dev/null
th_exec "cat > $APP_DIR/.env-production" <<ENV
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
ENV
th_exec "cd $APP_DIR && docker compose -p $SLUG -f docker-compose.prod.yml --env-file .env-production up -d --wait postgres redis" \
  > "$TH_WORK/stack.log" 2>&1 \
  || { tail -20 "$TH_WORK/stack.log" >&2; fail "could not bring up postgres/redis on the host"; }
pass "postgres and redis are running on the host"

# ── status: docker compose ps, over SSH ──────────────────────────────────────
echo "==> status"
status_output="$("${OPSCTL[@]}" status 2>&1)" || true
echo "$status_output"
grep -q "postgres" <<<"$status_output" || fail "status does not mention postgres: $status_output"
grep -q "redis" <<<"$status_output" || fail "status does not mention redis: $status_output"
grep -qi "Up" <<<"$status_output" || fail "status does not report anything up: $status_output"
pass "status shows postgres and redis running"

# ── logs: docker compose logs <service>, over SSH ────────────────────────────
echo "==> logs postgres"
logs_output="$("${OPSCTL[@]}" logs postgres 2>&1)" || true
grep -q "database system is ready to accept connections" <<<"$logs_output" \
  || fail "logs postgres did not show Postgres' own ready message: $logs_output"
pass "logs postgres streams the container's real log output"

# ── shell: docker compose exec -it, over ssh -t ──────────────────────────────
# `exec -it` needs a real pty on both hops, which a CI runner's own stdio is
# not. python's pty.spawn stands in for the operator's terminal, the same way
# it would if you ran opsctl by hand — this is not something opsctl does for
# itself, deliberately: see cli/src/ssh.ts on why -t is the one thing this
# verb forces and nothing else does.
echo "==> shell (interactive exec, under an allocated pty)"
SHELL_LOG="$TH_WORK/shell.log"
python3 -c '
import os, pty, sys
status = pty.spawn(sys.argv[1:])
sys.exit(status if isinstance(status, int) else 0)
' "${OPSCTL[@]}" shell redis redis-cli ping \
  > "$SHELL_LOG" 2>&1 || true
grep -q "PONG" "$SHELL_LOG" || fail "shell redis redis-cli ping did not see PONG: $(cat "$SHELL_LOG")"
pass "shell opens a real interactive exec session into a named service"

echo "==> CLI check passed"
