#!/usr/bin/env bash
# Provision a throwaway host with the generated playbook and check what it left.
#
# Usage: scripts/check_provisioning.sh <generated-project-dir>
#
# The host is a privileged systemd container running a real sshd, reached over
# real SSH on a published port — not `docker exec`. That matters: the criteria
# are about who can log in and what the firewall lets through, and a docker
# connection would prove neither. What the container cannot stand in for is a
# reboot and a kernel of its own, so nothing here depends on either.
#
# The playbook is run twice. The first run has to leave the host ready; the
# second has to change nothing.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_provisioning.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

command -v docker >/dev/null || fail "docker is required"
command -v ansible-playbook >/dev/null || fail "ansible-playbook is required (pip install ansible)"

# The container's sshd answers here, published on the same port so that the
# inventory's ansible_port is the truth about the host rather than a translation
# of it — the playbook opens that port in the firewall, and a mismatch would
# lock the check out of its own host.
SSH_PORT=2222
# A port the firewall is never told about, published so that something outside
# the host can try to reach a listener on it. See the reachability check below.
BLOCKED_PORT=8080
NAME="provision-check-$$"
WORK="$(mktemp -d)"
KEY="$WORK/id_check"

cleanup() {
  echo "==> Tearing down"
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  docker image rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

# ── A host to provision ──────────────────────────────────────────────────────
ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C provision-check
cp "$KEY.pub" "$WORK/authorized_keys"

# Deliberately a plain sshd on a service, not Ubuntu's socket activation: it is
# the shape most VPS images ship, and it exercises the playbook's restart
# handler. Under socket activation sshd re-reads its configuration per
# connection, so the hardening lands there without the restart either way.
cat > "$WORK/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server sudo python3 \
      iproute2 iptables ca-certificates curl gnupg
RUN systemctl disable ssh.socket && systemctl enable ssh \
 && printf 'Port 2222\n' > /etc/ssh/sshd_config.d/10-port.conf \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 600 /root/.ssh/authorized_keys
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE

echo "==> Building the test host image"
docker build -q -t "$NAME" "$WORK" >/dev/null

echo "==> Starting it"
# Privileged with the host's cgroup namespace: systemd needs to manage units,
# and ufw needs to write iptables rules. /var/lib/docker is a volume so the
# Docker the playbook installs is not stacking a filesystem on this container's.
docker run -d --name "$NAME" \
  --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --mount type=volume,dst=/var/lib/docker \
  -p "127.0.0.1:$SSH_PORT:$SSH_PORT" \
  -p "127.0.0.1:$BLOCKED_PORT:$BLOCKED_PORT" \
  "$NAME" >/dev/null

# IdentitiesOnly, because the machine running this may have a loaded agent and
# sshd stops after a handful of offers — which is Ansible's own behaviour when
# the inventory names a key.
SSH_BASE=(-o BatchMode=yes -o StrictHostKeyChecking=no
          -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
          -o IdentitiesOnly=yes -o ConnectTimeout=5 -p "$SSH_PORT")
SSH_OPTS=("${SSH_BASE[@]}" -i "$KEY")
as_user() { ssh "${SSH_OPTS[@]}" "$1@127.0.0.1" "$2"; }
in_host() { docker exec "$NAME" bash -c "$1"; }

await() {
  local what="$1"
  shift
  for _ in $(seq 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
systemd_ready() {
  # "degraded" is a booted system with a failed unit, which a container always
  # has a couple of (udev, and anything wanting real hardware).
  docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE '^(running|degraded)$'
}
await "systemd to finish booting" systemd_ready
await "sshd to answer" ssh "${SSH_OPTS[@]}" root@127.0.0.1 true

cat > "$WORK/inventory.ini" <<INVENTORY
[vps]
provision-check ansible_host=127.0.0.1 ansible_port=$SSH_PORT ansible_ssh_private_key_file=$KEY ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
INVENTORY

run_playbook() {
  ansible-playbook -i "$WORK/inventory.ini" ansible/provision.yml "$@"
}

# ── First run: a fresh host, reached as root ─────────────────────────────────
echo "==> Run 1: provisioning from scratch"
run_playbook | tee "$WORK/run1.log"
grep -q "Connecting as root" "$WORK/run1.log" \
  || fail "run 1 did not connect as root — the account probe picked the wrong user"
pass "a single command took a fresh host to a ready state"

# ── What it left behind ──────────────────────────────────────────────────────
# Everything that can be checked without SSH is checked without SSH: every
# refused login is a strike against the control machine in fail2ban's ledger,
# and this check should not be the thing that trips its own jail.

# Criterion: SSH is key-only and root login is disabled.
# `sshd -T` is the daemon's own resolved configuration, so this covers drop-ins
# the playbook never wrote as well as the one it did.
effective="$(in_host "sshd -T")"
grep -qx "permitrootlogin no" <<<"$effective" || fail "sshd still permits root login"
grep -qx "passwordauthentication no" <<<"$effective" || fail "sshd still accepts passwords"
grep -qx "kbdinteractiveauthentication no" <<<"$effective" \
  || fail "sshd still accepts keyboard-interactive authentication"
pass "sshd is key-only with root login disabled"

# Criterion: the firewall exposes only what is needed.
ufw_status="$(in_host "ufw status verbose")"
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
docker exec -d "$NAME" python3 -m http.server "$BLOCKED_PORT" --bind 0.0.0.0
await "the unlisted listener to come up" \
  docker exec "$NAME" curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$BLOCKED_PORT/"
if curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$BLOCKED_PORT/" 2>/dev/null; then
  fail "port $BLOCKED_PORT answers from outside the host, but no ufw rule allows it"
fi
pass "a listener on unallowed port $BLOCKED_PORT is reachable inside the host and not outside"

# Intrusion banning, part one: the jail is running and watching the right thing.
# On this release that means the journal — a jail pointed at /var/log/auth.log
# would be running and blind. Part two, that it actually bans, is at the end.
in_host "fail2ban-client status sshd" >/dev/null \
  || fail "fail2ban has no sshd jail running"
in_host "fail2ban-client status sshd | grep -q 'Journal matches'" \
  || fail "the sshd jail is not reading the journal, so it will never see a failure"
pass "fail2ban is banning SSH authentication failures from the journal"

# Criterion: unattended security upgrades are active.
in_host "systemctl is-enabled unattended-upgrades" >/dev/null \
  || fail "unattended-upgrades is not enabled"
# The unit above is only the shutdown hook. These timers are what read
# APT::Periodic and run the upgrade, so without them nothing is ever installed
# and every other assertion here would still pass.
for timer in apt-daily.timer apt-daily-upgrade.timer; do
  in_host "systemctl is-enabled $timer" >/dev/null || fail "$timer is not enabled"
  in_host "systemctl is-active $timer" >/dev/null || fail "$timer is not running"
done
periodic="$(in_host "apt-config dump APT::Periodic")"
grep -q 'APT::Periodic::Unattended-Upgrade "1"' <<<"$periodic" \
  || fail "the unattended upgrade is not scheduled: $periodic"
# Every entry in the list, which apt-config prints as `key:: "value";` lines.
origins="$(in_host "apt-config dump Unattended-Upgrade::Allowed-Origins" | grep ':: ' || true)"
grep -q -- "-security" <<<"$origins" || fail "no security origin is allowed: ${origins:-<empty>}"
# APT appends to a list rather than replacing it, so a missing #clear would
# leave the packaged origins in place and quietly widen this past security.
wider="$(grep -v -- "-security" <<<"$origins" || true)"
[[ -z "$wider" ]] || fail "unattended upgrades reach past security updates: $wider"
pass "the upgrade timers run and unattended upgrades are limited to security origins"

# Criterion: log rotation is active. Three places logs actually accumulate.
in_host "systemctl is-enabled logrotate.timer" >/dev/null \
  || fail "logrotate.timer is not enabled"
# cat-config is the merged configuration, so this is the value journald ends up
# with rather than the drop-in the playbook happens to have written.
in_host "systemd-analyze cat-config systemd/journald.conf | grep -qx 'SystemMaxUse=$JOURNAL_MAX'" \
  || fail "the journal is not capped at $JOURNAL_MAX"
in_host "grep -q '\"max-size\"' /etc/docker/daemon.json" \
  || fail "container logs are unbounded"
pass "logrotate, the journal cap and Docker's log limits are all in place"

# The container runtime, and the deploy user's access to it.
in_host "docker version --format '{{.Server.Version}}'" >/dev/null \
  || fail "the Docker daemon is not running"
in_host "docker compose version" >/dev/null || fail "the compose plugin is missing"
in_host "id -nG $DEPLOY_USER | tr ' ' '\n' | grep -qx docker" \
  || fail "$DEPLOY_USER cannot drive Docker"
pass "Docker and the compose plugin are installed and $DEPLOY_USER is in the docker group"

# Where deploys land.
owner_mode="$(in_host "stat -c '%U %a' $APP_DIR")"
[[ "$owner_mode" == "$DEPLOY_USER 755" ]] \
  || fail "$APP_DIR is '$owner_mode', expected '$DEPLOY_USER 755'"
pass "$APP_DIR exists and belongs to $DEPLOY_USER"

# ── What only a real login can answer ────────────────────────────────────────
as_user "$DEPLOY_USER" "sudo -n true" \
  || fail "$DEPLOY_USER cannot log in with the key, or cannot sudo without a password"
pass "$DEPLOY_USER logs in with a key and sudoes without a password"

# ── Second run: nothing left to do ───────────────────────────────────────────
echo "==> Run 2: re-running against the provisioned host"
run_playbook | tee "$WORK/run2.log"
grep -q "root login is already disabled" "$WORK/run2.log" \
  || fail "run 2 did not fall back to the deploy user"

recap="$(grep -E 'ok=[0-9]+ +changed=' "$WORK/run2.log" | tail -1)"
[[ -n "$recap" ]] || fail "no play recap in run 2's output"
if ! grep -qE 'changed=0 +unreachable=0 +failed=0' <<<"$recap"; then
  echo "--- tasks that reported a change on the second run ---" >&2
  grep -B3 '^changed:' "$WORK/run2.log" >&2 || true
  fail "re-running the playbook changed something: $recap"
fi
pass "re-running the playbook changes nothing ($recap)"

# ── The two checks that spend the host's patience ────────────────────────────
# Both of these deliberately fail authentication, and fail2ban is watching, so
# they come after everything that still needs to log in. The jail's default is
# five strikes inside ten minutes and a refused root login is worth two of them,
# which is the whole budget for three attempts.
if as_user root true 2>/dev/null; then
  fail "root can still log in over SSH"
fi
pass "root is refused over SSH"

# Criterion: intrusion banning, as behaviour rather than configuration. A jail
# can be running, enabled and watching the right log and still ban nobody.
echo "==> Hammering SSH until fail2ban bans this machine"
ssh-keygen -q -t ed25519 -N "" -f "$WORK/id_wrong" -C provision-check-wrong
WRONG_OPTS=("${SSH_BASE[@]}" -i "$WORK/id_wrong")
banned=""
for _ in $(seq 12); do
  ssh "${WRONG_OPTS[@]}" "not-a-user@127.0.0.1" true >/dev/null 2>&1 || true
  if [[ -n "$(in_host "fail2ban-client status sshd" | sed -n 's/.*Banned IP list:[[:space:]]*//p')" ]]; then
    banned=yes
    break
  fi
  sleep 1
done
[[ -n $banned ]] || fail "fail2ban banned nobody after a dozen failed logins"
pass "fail2ban bans a client that keeps failing authentication"

echo "==> Provisioning check passed"
