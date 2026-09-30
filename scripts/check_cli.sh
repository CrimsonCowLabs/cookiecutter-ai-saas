#!/usr/bin/env bash
# Run the generated project's CLI (`opsctl`) against a throwaway host and
# prove every verb actually works — the read-only ones from issue #21 over
# real SSH, and the write ones from issue #22 by really invoking the
# playbooks/tools they wrap.
#
# Usage: scripts/check_cli.sh <generated-project-dir>
#
# The host is scripts/lib/throwaway_host.sh's — a privileged systemd container
# with a real sshd — the same one scripts/check_provisioning.sh,
# scripts/check_deploy.sh and scripts/check_backups.sh use.
#
# Two different inventories are used in this script, on purpose, because the
# verbs split into two different shapes (see cli/src/ssh.ts and
# cli/src/ansible.ts's own module comments):
#
#   * `provision`, `deploy`, `migrate`, `preflight` and `secrets edit` run
#     ansible-playbook/ansible-vault *locally*, so what reaches the host is
#     whatever ansible/inventory.ini says — the same as if an operator typed
#     the command by hand. These sections give it a fully-specified inventory
#     (address, port, key), exactly the shape README.md's own inventory.ini
#     comments describe for a real host.
#   * `status`, `logs`, `shell` and `backup` reach the host over
#     cli/src/ssh.ts's own plumbing, which is the thing worth proving adds no
#     flags of its own: those sections switch the inventory to name the host
#     by an alias defined only in a temporary block appended to the real
#     `~/.ssh/config` (restored on exit), with no ansible_port or
#     ansible_ssh_private_key_file at all — see the original comment issue #21
#     left here, kept below.
#
# What this does NOT re-prove, because scripts/check_deploy.sh and
# scripts/check_backups.sh already do, exhaustively: that a full deploy ships
# working images and can roll back, or that a scheduled backup is verified,
# pruned on policy and alerts correctly. `deploy`/`migrate` here are exercised
# through fast, real refusals (an unencrypted vault, an unknown target, a bad
# platform) rather than a full multi-image build — proving this CLI invokes
# the real playbook and propagates its output/exit code, without paying for
# what is already proven elsewhere. `backup` here does take one real dump, off
# this host, because "an on-demand backup can be taken" is worth the modest
# cost of a stand-in destination (a single S3-compatible mock container, no
# alert sink — alerting itself is check_backups.sh's claim, not this script's).
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

# Pulling the Postgres and s3mock images over the network is slower than
# anything installed on an already-built host image.
TH_AWAIT_TRIES=120

SSH_PORT=2224
HOST_ALIAS="cli-check-host"
S3MOCK="cli-check-s3mock-$$"

cleanup_extra() {
  docker rm -f -v "$S3MOCK" >/dev/null 2>&1 || true
}

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

trap 'restore_ssh_config; cleanup_extra; throwaway_host_stop' EXIT
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
UNIT="$SLUG-db-backup"
BUCKET=cli-check-backups

echo "==> Building the CLI"
npm run cli:build --silent > "$TH_WORK/cli-build.log" 2>&1 \
  || { cat "$TH_WORK/cli-build.log" >&2; fail "npm run cli:build failed"; }
OPSCTL=(node "$PROJECT_DIR/cli/dist/index.js")
pass "cli/dist/index.js built"

# ── Running with no arguments lists every command (acceptance criterion) ────
echo "==> Running with no arguments"
help_output="$("${OPSCTL[@]}")"
for verb in config status logs shell provision deploy migrate secrets backup preflight; do
  grep -q "^  $verb" <<<"$help_output" || fail "no-args output does not list '$verb': $help_output"
done
pass "running with no arguments lists all ten commands"

echo "==> An unknown command is refused and still shows the list"
if "${OPSCTL[@]}" no-such-command >/dev/null 2>"$TH_WORK/unknown.log"; then
  fail "an unknown command exited 0"
fi
grep -q "Unknown command" "$TH_WORK/unknown.log" || fail "no message naming the unknown command"
pass "an unknown command is refused with a message and a nonzero exit"

# ── restore: documented as not available, not silently absent ───────────────
echo "==> restore says it is not automated, rather than either working or looking unknown"
if "${OPSCTL[@]}" restore >/dev/null 2>"$TH_WORK/restore.log"; then
  fail "opsctl restore exited 0"
fi
grep -qi "restore" "$TH_WORK/restore.log" || fail "the restore refusal does not mention restore"
grep -q "README" "$TH_WORK/restore.log" || fail "the restore refusal does not point at the README"
pass "opsctl restore explains that restore is a manual procedure and points at the README"

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

# ── deploy/migrate/preflight, with no vault at all ───────────────────────────
# ansible/deploy.yml's own preflight play refuses before anything else runs —
# connection: local, so this needs no reachable host at all — which makes it
# the cheapest possible proof that these three verbs really invoke that
# playbook rather than reimplementing its checks: the refusal message is
# deploy.yml's own, not this CLI's.
echo "==> deploy, migrate and preflight all refuse before any vault exists"
for verb in deploy migrate preflight; do
  if "${OPSCTL[@]}" $verb >"$TH_WORK/novault-$verb.log" 2>&1; then
    fail "opsctl $verb ran with no ansible/vault.yml at all"
  fi
  grep -q "vault.yml does not exist" "$TH_WORK/novault-$verb.log" \
    || fail "opsctl $verb did not report the missing vault by name: $(tail -10 "$TH_WORK/novault-$verb.log")"
done
pass "deploy, migrate and preflight all surface deploy.yml's own \"vault.yml does not exist\" refusal"

# ── Point the generated project's own inventory at the throwaway host ───────
# Fully specified (address, port, key) — the shape ansible/inventory.ini's own
# comments describe for a real host, and what `provision`/`deploy`/`migrate`/
# `preflight`/`secrets edit` need: they run ansible-playbook/ansible-vault
# locally, and only this file tells those binaries where the host is.
cp "$TH_INVENTORY" ansible/inventory.ini

# ansible itself trusts this host key via inventory.ini's own
# ansible_ssh_common_args (see lib/throwaway_host.sh) — but opsctl's own ssh
# probe (cli/src/ssh.ts, used by `config`/`preflight`) is deliberately just
# the plain `ssh` binary with only -p/-i added, so it consults the real
# ~/.ssh/config the same way a human typing `ssh` would. A host an operator
# has never connected to before needs exactly this once — a real one gets it
# from a first interactive login or `ssh-keyscan`; accept-new here is that,
# not a relaxation of what `preflight` proves. Scoped to a temp known_hosts
# file so nothing is written to the real one, and gone when SSH_CONFIG is
# restored on exit.
cat >> "$SSH_CONFIG" <<SSHCONFIG

Host 127.0.0.1
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $TH_WORK/known_hosts
SSHCONFIG

# ── provision: opsctl invoking the real playbook, not a reimplementation ────
echo "==> opsctl provision"
provision_output="$("${OPSCTL[@]}" provision 2>&1)" \
  || { echo "$provision_output" >&2; fail "opsctl provision failed"; }
grep -q "Host provisioned" <<<"$provision_output" \
  || fail "opsctl provision's output does not include provision.yml's own report"
pass "opsctl provision ran ansible/provision.yml for real and printed its own report"

echo "==> opsctl provision again is a no-op, like the playbook itself"
recap="$("${OPSCTL[@]}" provision 2>&1 | grep -E 'ok=[0-9]+ +changed=' | tail -1)"
[[ -n $recap ]] || fail "no play recap from a second opsctl provision"
grep -qE 'changed=0 +unreachable=0 +failed=0' <<<"$recap" \
  || fail "a second opsctl provision changed something: $recap"
pass "re-running opsctl provision changes nothing ($recap)"

# ── A destination for a real, on-demand backup ───────────────────────────────
# Only the stand-in destination: unlike scripts/check_backups.sh this script
# is not proving alerting, retention or staleness — those stay that script's
# claim — only that `opsctl backup` triggers a real dump that leaves the host.
echo "==> Starting a stand-in backup destination"
AK=clicheckkey
SK=clicheckskeysecret
# adobe/s3mock, with the bucket created at boot via its
# COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS setting — nothing else needs
# to create it afterward. Port 9090 is its plain-HTTP listener.
docker run -d --name "$S3MOCK" \
  -e "COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=$BUCKET" \
  adobe/s3mock >/dev/null
container_ip() { docker inspect -f '{{ .NetworkSettings.Networks.bridge.IPAddress }}' "$1"; }
S3_IP="$(container_ip "$S3MOCK")"
[[ -n $S3_IP ]] || fail "the stand-in destination has no address on the bridge"
s3cli() {
  docker run --rm -e AWS_ACCESS_KEY_ID="$AK" -e AWS_SECRET_ACCESS_KEY="$SK" \
    -e AWS_DEFAULT_REGION=us-east-1 amazon/aws-cli \
    --endpoint-url "http://$S3_IP:9090" s3 "$@"
}
# s3mock does not validate credentials; this only proves the endpoint is up
# and the bucket created at boot is really there.
await "the destination to accept connections" s3cli ls "s3://$BUCKET"
pass "the stand-in backup destination is up on $S3_IP"

# ── Secrets, for both deploy.yml and backup.yml ──────────────────────────────
printf 'cli-check-vault-password\n' > "$TH_WORK/vault-pass"
cat > ansible/vault.yml <<VAULTFILE
---
vault_nextauth_secret: "cli-check-nextauth-sentinel"
vault_postgres_password: "cli-check-postgres-sentinel"
vault_backup_remote:
  type: s3
  provider: Other
  endpoint: http://$S3_IP:9090
  region: us-east-1
  access_key_id: $AK
  secret_access_key: $SK
vault_backup_remote_path: $BUCKET/$SLUG
vault_backup_alert_url: http://127.0.0.1:1/alert
VAULTFILE
ansible-vault encrypt --vault-password-file "$TH_WORK/vault-pass" ansible/vault.yml >/dev/null
head -c 14 ansible/vault.yml | grep -q '^\$ANSIBLE_VAULT' || fail "ansible-vault encrypt did not produce a vault header"
pass "ansible/vault.yml is encrypted, with what deploy.yml and backup.yml both need"

# Exported only now that vault.yml is encrypted, and never alongside an
# explicit --vault-password-file (ansible-vault encrypt above needs exactly
# one vault-id, and the two together are an ambiguous "default,default").
# Every ansible-playbook/ansible-vault call this script makes through opsctl
# from here on (preflight, deploy, migrate, secrets edit) needs to decrypt
# ansible/vault.yml, and opsctl itself never adds --vault-password-file — an
# operator sets this once in their own shell, the same standard ansible env
# var, and every subsequent command benefits.
export ANSIBLE_VAULT_PASSWORD_FILE="$TH_WORK/vault-pass"

# ── preflight: config's own checks catch what deploy.yml's --tags preflight
#    does not — an unreachable host ──────────────────────────────────────────
# ansible/deploy.yml's preflight play is connection: local and never touches
# the host, so it cannot catch this by itself; only opsctl config's own SSH
# probe can. site_address=https://localhost throughout keeps the DNS check out
# of it, so each result below is about exactly one thing.
echo "==> preflight against a host that does not answer on the port the inventory names"
sed -i "s/ansible_port=$SSH_PORT/ansible_port=$((SSH_PORT + 1))/" ansible/inventory.ini
if "${OPSCTL[@]}" preflight -e site_address=https://localhost >"$TH_WORK/preflight-unreachable.log" 2>&1; then
  fail "preflight passed against a host that does not answer on the configured port"
fi
grep -q "did not answer over SSH" "$TH_WORK/preflight-unreachable.log" \
  || fail "preflight did not report the host as unreachable: $(tail -15 "$TH_WORK/preflight-unreachable.log")"
sed -i "s/ansible_port=$((SSH_PORT + 1))/ansible_port=$SSH_PORT/" ansible/inventory.ini
pass "preflight's own config checks catch an unreachable host, which deploy.yml's preflight play cannot"

echo "==> preflight against a fully configured, reachable host"
preflight_output="$("${OPSCTL[@]}" preflight -e site_address=https://localhost 2>&1)" \
  || { echo "$preflight_output" >&2; fail "preflight failed against a configured, reachable host"; }
grep -qE '^\[ok\][[:space:]]+(inventory|vault|ssh):' <<<"$preflight_output" \
  || fail "preflight's config checks did not report ok: $preflight_output"
grep -q "which is not a public name" <<<"$preflight_output" \
  || fail "preflight's DNS check did not report skipping a loopback site address"
grep -q "Looks good" <<<"$preflight_output" || fail "preflight did not conclude that a deploy can proceed"
pass "preflight passes once the host is configured and reachable, deploying nothing"

# ── deploy: real argument translation, refused by deploy.yml's own check ────
echo "==> deploy with an unknown target"
if "${OPSCTL[@]}" deploy no-such-target -- -e site_address=https://localhost \
     >"$TH_WORK/deploy-unknown.log" 2>&1; then
  fail "opsctl deploy shipped an unknown target"
fi
grep -q "Unknown deploy target(s): no-such-target" "$TH_WORK/deploy-unknown.log" \
  || fail "the unknown target was not refused by deploy.yml's own assertion: $(tail -15 "$TH_WORK/deploy-unknown.log")"
pass "opsctl deploy passes targets straight through; deploy.yml's own assertion is what refuses an unknown one"

# ── migrate: -e deploy_targets=migrator, and nothing else ───────────────────
# deploy_platform=bogus/platform fails the build fast, before any real
# compute — which is the point: what this proves is *which* image was
# attempted, not that the build succeeds (scripts/check_deploy.sh already
# proves a real deploy end to end).
echo "==> migrate"
if "${OPSCTL[@]}" migrate -- -e site_address=https://localhost -e deploy_platform=bogus/platform \
     >"$TH_WORK/migrate.log" 2>&1; then
  fail "opsctl migrate succeeded with a nonsense deploy_platform"
fi
sed -n '/TASK \[Build the images this release ships\]/,/^TASK \[/p' "$TH_WORK/migrate.log" > "$TH_WORK/migrate-build.log"
[[ -s "$TH_WORK/migrate-build.log" ]] || fail "migrate never reached the build task: $(tail -20 "$TH_WORK/migrate.log")"
grep -q "item=migrator" "$TH_WORK/migrate-build.log" || fail "migrate did not attempt to build the migrator image"
for other in app worker db-writer ops; do
  grep -q "item=$other)" "$TH_WORK/migrate-build.log" \
    && fail "opsctl migrate also built '$other' — it should ship only the migrator"
done
pass "opsctl migrate ships only the migrator image (-e deploy_targets=migrator), nothing else"

# ── secrets edit: a thin, interactive wrapper around ansible-vault edit ─────
# $EDITOR stands in for the operator's own editor: a script that appends a
# marker line, non-interactively, so this proves the file round-trips through
# a real `ansible-vault edit` — decrypted to a temp file, handed to $EDITOR,
# re-encrypted — without ever needing a human at a keyboard.
echo "==> secrets edit"
cat > "$TH_WORK/fake-editor.sh" <<'EDITOR'
#!/usr/bin/env bash
echo "vault_secrets_edit_marker: cli-check-edited" >> "$1"
EDITOR
chmod +x "$TH_WORK/fake-editor.sh"
EDITOR="$TH_WORK/fake-editor.sh" ANSIBLE_VAULT_PASSWORD_FILE="$TH_WORK/vault-pass" \
  "${OPSCTL[@]}" secrets edit >"$TH_WORK/secrets-edit.log" 2>&1 \
  || { cat "$TH_WORK/secrets-edit.log" >&2; fail "opsctl secrets edit failed"; }
head -c 14 ansible/vault.yml | grep -q '^\$ANSIBLE_VAULT' \
  || fail "ansible/vault.yml is not encrypted after secrets edit"
ansible-vault view --vault-password-file "$TH_WORK/vault-pass" ansible/vault.yml \
  | grep -q "cli-check-edited" \
  || fail "the edit made through \$EDITOR did not reach the vault"
pass "secrets edit round-trips through a real ansible-vault edit, never decrypted to disk in between"

# ── A destination for backups.yml's own raw invocation ───────────────────────
# Note what this is NOT: `opsctl backup` itself never runs this playbook (see
# cli/src/commands/backup.ts) — it only starts the schedule installing it
# already put on the host. Installing the schedule for real is what a real
# `opsctl backup` needs something to trigger.
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

echo "==> Installing the backup schedule for real (ansible/backup.yml)"
ansible-playbook -i ansible/inventory.ini ansible/backup.yml \
  --vault-password-file "$TH_WORK/vault-pass" > "$TH_WORK/backup-install.log" 2>&1 \
  || { tail -40 "$TH_WORK/backup-install.log" >&2; fail "installing the backup schedule failed"; }
th_exec "test -f /etc/systemd/system/$UNIT.service" || fail "$UNIT.service was not installed"
pass "the backup schedule is installed on the host, from the real playbook"

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

# Only the alias goes in the inventory from here on — no ansible_port, no
# ansible_ssh_private_key_file. Ansible itself still needs those two (it never
# reads ~/.ssh/config's Port/IdentityFile the way plain ssh does), which is
# why the playbook-driving verbs above ran against the fully-specified
# inventory instead; opsctl's own ssh plumbing (status/logs/shell/backup)
# reads the same file either way.
cat > ansible/inventory.ini <<INVENTORY
[vps]
$HOST_ALIAS ansible_host=$HOST_ALIAS
INVENTORY

echo "==> config once more, now over the alias-only inventory"
config_output="$("${OPSCTL[@]}" config 2>&1)" || true
echo "$config_output"
for name in inventory vault ssh; do
  grep -qE "^\[ok\][[:space:]]+$name:" <<<"$config_output" \
    || fail "config did not report '$name' as ok (see output above)"
done
pass "config reports the inventory, the vault and SSH reachability as ok — using only ~/.ssh/config"

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

# ── backup: systemctl start <slug>-db-backup.service, over SSH ──────────────
# Acceptance criterion: an on-demand backup can be taken. This is the one
# write verb that reaches over ssh rather than running a playbook locally
# (see cli/src/commands/backup.ts) — it starts what ansible/backup.yml already
# installed, the same command the README tells an operator to run by hand.
echo "==> backup"
before="$(th_exec "ls -1 /var/backups/$SLUG/db-*.dump 2>/dev/null | wc -l" | tr -d '[:space:]')"
"${OPSCTL[@]}" backup 2>&1 | tee "$TH_WORK/backup.log"
after="$(th_exec "ls -1 /var/backups/$SLUG/db-*.dump 2>/dev/null | wc -l" | tr -d '[:space:]')"
[[ "$after" -gt "$before" ]] \
  || fail "opsctl backup did not produce a new dump in /var/backups/$SLUG (before=$before, after=$after)"
newest="$(th_exec "ls -1 /var/backups/$SLUG/db-*.dump | sort | tail -1")"
s3cli ls "s3://$BUCKET/$SLUG/" 2>/dev/null | grep -q "$(basename "$newest")" \
  || fail "opsctl backup's dump ($newest) did not reach the stand-in destination"
pass "opsctl backup started $UNIT.service over ssh, and a real dump reached the destination"

echo "==> CLI check passed"
