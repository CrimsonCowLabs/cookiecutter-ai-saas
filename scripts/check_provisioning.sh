#!/usr/bin/env bash
# Provision a throwaway host with the generated playbook and check what it left.
#
# Usage: scripts/check_provisioning.sh <generated-project-dir>
#
# The host comes from scripts/lib/throwaway_host.sh — a privileged systemd
# container running a real sshd, reached over real SSH on a published port, not
# `docker exec`. That matters: the criteria are about who can log in and what
# the firewall lets through, and a docker connection would prove neither.
#
# The playbook is run twice. The first run has to leave the host ready; the
# second has to change nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/throwaway_host.sh
source "$SCRIPT_DIR/lib/throwaway_host.sh"

PROJECT_DIR="${1:?usage: check_provisioning.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

throwaway_host_require_tools

# The container's sshd answers here, published on the same port so that the
# inventory's ansible_port is the truth about the host rather than a translation
# of it — the playbook opens that port in the firewall, and a mismatch would
# lock the check out of its own host.
SSH_PORT=2222
# A port the firewall is never told about, published so that something outside
# the host can try to reach a listener on it. See the reachability check below.
BLOCKED_PORT=8080

trap throwaway_host_stop EXIT
throwaway_host_start "provision-check-$$" "$SSH_PORT" "$BLOCKED_PORT:$BLOCKED_PORT"

# What the playbook decided at generation time. Read it out of the generated
# tree rather than re-deriving it here, which is only the same thing until
# somebody changes one of them.
VARS=ansible/group_vars/all.yml
[[ -f $VARS ]] || fail "no $VARS in $PROJECT_DIR — is this a generated project?"
DEPLOY_USER="$(sed -n 's/^deploy_user: *//p' "$VARS" | head -1)"
APP_DIR="$(sed -n 's/^app_dir: *//p' "$VARS" | head -1)"
JOURNAL_MAX="$(sed -n 's/^journal_max_use: *//p' "$VARS" | head -1)"
[[ -n $DEPLOY_USER && -n $APP_DIR && -n $JOURNAL_MAX ]] \
  || fail "could not read deploy_user/app_dir/journal_max_use out of $VARS"
echo "==> Provisioning for deploy user '$DEPLOY_USER', app dir '$APP_DIR'"

run_playbook() {
  ansible-playbook -i "$TH_INVENTORY" ansible/provision.yml "$@"
}

# ── First run: a fresh host, reached as root ─────────────────────────────────
echo "==> Run 1: provisioning from scratch"
run_playbook | tee "$TH_WORK/run1.log"
grep -q "Connecting as root" "$TH_WORK/run1.log" \
  || fail "run 1 did not connect as root — the account probe picked the wrong user"
pass "a single command took a fresh host to a ready state"

# ── What it left behind ──────────────────────────────────────────────────────
# Everything that can be checked without SSH is checked without SSH: every
# refused login is a strike against the control machine in fail2ban's ledger,
# and this check should not be the thing that trips its own jail.

# Criterion: SSH is key-only and root login is disabled.
# `sshd -T` is the daemon's own resolved configuration, so this covers drop-ins
# the playbook never wrote as well as the one it did.
effective="$(th_exec "sshd -T")"
grep -qx "permitrootlogin no" <<<"$effective" || fail "sshd still permits root login"
grep -qx "passwordauthentication no" <<<"$effective" || fail "sshd still accepts passwords"
grep -qx "kbdinteractiveauthentication no" <<<"$effective" \
  || fail "sshd still accepts keyboard-interactive authentication"
pass "sshd is key-only with root login disabled"

# Criterion: the firewall exposes only what is needed.
ufw_status="$(th_exec "ufw status verbose")"
grep -q "^Status: active" <<<"$ufw_status" || fail "ufw is not active: $ufw_status"
grep -q "^Default: deny (incoming)" <<<"$ufw_status" \
  || fail "ufw does not deny incoming by default: $ufw_status"
# The (v6) suffix on the IPv6 copy of each rule is dropped by taking the port
# field alone, so this is the set of ports, not the set of rules.
allowed="$(awk '/ALLOW/ {print $1}' <<<"$ufw_status" | sort -u | paste -sd, -)"
# Hardcoded on purpose, unlike the values read out of group_vars above: this is
# the criterion ("only what is needed"), not an echo of the configuration. Widen
# firewall_tcp_ports and this check should fail and be argued with, not follow.
expected="$SSH_PORT/tcp,443/tcp,443/udp,80/tcp"
[[ "$allowed" == "$expected" ]] \
  || fail "ufw allows '$allowed', expected exactly '$expected'"
pass "ufw is active, denies inbound by default and allows only $expected"

# A rule table is a claim; this is the claim tested. A listener goes up on a
# port no rule mentions, and the outside has to be unable to reach it — proving
# the default-deny is enforced rather than merely configured.
docker exec -d "$TH_NAME" python3 -m http.server "$BLOCKED_PORT" --bind 0.0.0.0
await "the unlisted listener to come up" \
  docker exec "$TH_NAME" curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$BLOCKED_PORT/"
if curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$BLOCKED_PORT/" 2>/dev/null; then
  fail "port $BLOCKED_PORT answers from outside the host, but no ufw rule allows it"
fi
pass "a listener on unallowed port $BLOCKED_PORT is reachable inside the host and not outside"

# Intrusion banning, part one: the jail is running and watching the right thing.
# On this release that means the journal — a jail pointed at /var/log/auth.log
# would be running and blind. Part two, that it actually bans, is at the end.
th_exec "fail2ban-client status sshd" >/dev/null \
  || fail "fail2ban has no sshd jail running"
th_exec "fail2ban-client status sshd | grep -q 'Journal matches'" \
  || fail "the sshd jail is not reading the journal, so it will never see a failure"
pass "fail2ban is banning SSH authentication failures from the journal"

# Criterion: unattended security upgrades are active.
th_exec "systemctl is-enabled unattended-upgrades" >/dev/null \
  || fail "unattended-upgrades is not enabled"
# The unit above is only the shutdown hook. These timers are what read
# APT::Periodic and run the upgrade, so without them nothing is ever installed
# and every other assertion here would still pass.
for timer in apt-daily.timer apt-daily-upgrade.timer; do
  th_exec "systemctl is-enabled $timer" >/dev/null || fail "$timer is not enabled"
  th_exec "systemctl is-active $timer" >/dev/null || fail "$timer is not running"
done
periodic="$(th_exec "apt-config dump APT::Periodic")"
grep -q 'APT::Periodic::Unattended-Upgrade "1"' <<<"$periodic" \
  || fail "the unattended upgrade is not scheduled: $periodic"
# Every entry in the list, which apt-config prints as `key:: "value";` lines.
origins="$(th_exec "apt-config dump Unattended-Upgrade::Allowed-Origins" | grep ':: ' || true)"
grep -q -- "-security" <<<"$origins" || fail "no security origin is allowed: ${origins:-<empty>}"
# APT appends to a list rather than replacing it, so a missing #clear would
# leave the packaged origins in place and quietly widen this past security.
wider="$(grep -v -- "-security" <<<"$origins" || true)"
[[ -z "$wider" ]] || fail "unattended upgrades reach past security updates: $wider"
pass "the upgrade timers run and unattended upgrades are limited to security origins"

# Criterion: log rotation is active. Three places logs actually accumulate.
th_exec "systemctl is-enabled logrotate.timer" >/dev/null \
  || fail "logrotate.timer is not enabled"
# cat-config is the merged configuration, so this is the value journald ends up
# with rather than the drop-in the playbook happens to have written.
th_exec "systemd-analyze cat-config systemd/journald.conf | grep -qx 'SystemMaxUse=$JOURNAL_MAX'" \
  || fail "the journal is not capped at $JOURNAL_MAX"
th_exec "grep -q '\"max-size\"' /etc/docker/daemon.json" \
  || fail "container logs are unbounded"
pass "logrotate, the journal cap and Docker's log limits are all in place"

# The container runtime, and the deploy user's access to it.
th_exec "docker version --format '{{.Server.Version}}'" >/dev/null \
  || fail "the Docker daemon is not running"
th_exec "docker compose version" >/dev/null || fail "the compose plugin is missing"
th_exec "id -nG $DEPLOY_USER | tr ' ' '\n' | grep -qx docker" \
  || fail "$DEPLOY_USER cannot drive Docker"
pass "Docker and the compose plugin are installed and $DEPLOY_USER is in the docker group"

# Where deploys land.
owner_mode="$(th_exec "stat -c '%U %a' $APP_DIR")"
[[ "$owner_mode" == "$DEPLOY_USER 755" ]] \
  || fail "$APP_DIR is '$owner_mode', expected '$DEPLOY_USER 755'"
pass "$APP_DIR exists and belongs to $DEPLOY_USER"

# ── What only a real login can answer ────────────────────────────────────────
th_ssh "$DEPLOY_USER" "sudo -n true" \
  || fail "$DEPLOY_USER cannot log in with the key, or cannot sudo without a password"
pass "$DEPLOY_USER logs in with a key and sudoes without a password"

# ── Second run: nothing left to do ───────────────────────────────────────────
echo "==> Run 2: re-running against the provisioned host"
run_playbook | tee "$TH_WORK/run2.log"
grep -q "root login is already disabled" "$TH_WORK/run2.log" \
  || fail "run 2 did not fall back to the deploy user"

recap="$(grep -E 'ok=[0-9]+ +changed=' "$TH_WORK/run2.log" | tail -1)"
[[ -n "$recap" ]] || fail "no play recap in run 2's output"
if ! grep -qE 'changed=0 +unreachable=0 +failed=0' <<<"$recap"; then
  echo "--- tasks that reported a change on the second run ---" >&2
  grep -B3 '^changed:' "$TH_WORK/run2.log" >&2 || true
  fail "re-running the playbook changed something: $recap"
fi
pass "re-running the playbook changes nothing ($recap)"

# ── The two checks that spend the host's patience ────────────────────────────
# Both of these deliberately fail authentication, and fail2ban is watching, so
# they come after everything that still needs to log in. The jail's default is
# five strikes inside ten minutes and a refused root login is worth two of them,
# which is the whole budget for three attempts.
if th_ssh root true 2>/dev/null; then
  fail "root can still log in over SSH"
fi
pass "root is refused over SSH"

# Criterion: intrusion banning, as behaviour rather than configuration. A jail
# can be running, enabled and watching the right log and still ban nobody.
echo "==> Hammering SSH until fail2ban bans this machine"
ssh-keygen -q -t ed25519 -N "" -f "$TH_WORK/id_wrong" -C provision-check-wrong
WRONG_OPTS=("${TH_SSH_BASE[@]}" -i "$TH_WORK/id_wrong")
banned=""

# The attempt that trips the ban is the one that hangs. fail2ban's DROP rule
# lands while that connection is already past the TCP handshake and waiting on
# authentication, and -o ConnectTimeout governs only the connect — so ssh sits
# there with nothing to time it out, on the very attempt that proves the jail
# works. Bound the attempt itself rather than the connect. `timeout(1)` would be
# the obvious tool and is not on a stock macOS, where this check is also run by
# hand.
attempt_login() {
  ssh "${WRONG_OPTS[@]}" "not-a-user@127.0.0.1" true >/dev/null 2>&1 &
  local ssh_pid=$!
  (sleep 8 && kill -9 "$ssh_pid") >/dev/null 2>&1 &
  local killer_pid=$!
  wait "$ssh_pid" 2>/dev/null || true
  kill "$killer_pid" >/dev/null 2>&1 || true
}

for _ in $(seq 12); do
  attempt_login
  if [[ -n "$(th_exec "fail2ban-client status sshd" | sed -n 's/.*Banned IP list:[[:space:]]*//p')" ]]; then
    banned=yes
    break
  fi
  sleep 1
done
[[ -n $banned ]] || fail "fail2ban banned nobody after a dozen failed logins"
pass "fail2ban bans a client that keeps failing authentication"

echo "==> Provisioning check passed"
