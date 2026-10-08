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
# The same, for a container that publishes a port through Docker. Docker used to
# write its own iptables rules for that, ahead of ufw's, which is exactly the
# hole this second port is here to prove closed.
DOCKER_BLOCKED_PORT=8081

trap throwaway_host_stop EXIT
throwaway_host_start "provision-check-$$" "$SSH_PORT" \
  "$BLOCKED_PORT:$BLOCKED_PORT" "$DOCKER_BLOCKED_PORT:$DOCKER_BLOCKED_PORT"

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
grep -q "^Default: deny (incoming), allow (outgoing), deny (routed)" <<<"$ufw_status" \
  || fail "ufw does not deny incoming and routed traffic by default: $ufw_status"
# The (v6) suffix on the IPv6 copy of each rule is dropped by taking the port
# field alone, so this is the set of ports, not the set of rules. ALLOW IN, not
# ALLOW: the forwarding rule below is ALLOW FWD and is not an open port.
allowed="$(awk '/ALLOW IN/ {print $1}' <<<"$ufw_status" | sort -u | paste -sd, -)"
# Hardcoded on purpose, unlike the values read out of group_vars above: this is
# the criterion ("only what is needed"), not an echo of the configuration. Widen
# firewall_tcp_ports and this check should fail and be argued with, not follow.
expected="$SSH_PORT/tcp,443/tcp,443/udp,80/tcp"
[[ "$allowed" == "$expected" ]] \
  || fail "ufw allows '$allowed', expected exactly '$expected'"
pass "ufw is active, denies inbound by default and allows only $expected"

# Forwarding is what containers need from the firewall now that Docker writes
# none of its own rules: traffic that starts on a container network — every
# bridge compose creates (br-+) and Docker's default one — may leave it.
# Nothing is forwarded *to* a container that it did not ask for; that would be
# a published port by another name. Comments and the (v6) twins are dropped, so
# this is the set of rules rather than their spelling.
routed="$(grep 'ALLOW FWD' <<<"$ufw_status" | sed -e 's/ *#.*//' -e 's/ (v6)//g' \
  | tr -s ' ' | sort -u | paste -sd'|' -)"
expected_routed="Anywhere ALLOW FWD Anywhere on br-+|Anywhere ALLOW FWD Anywhere on docker0"
[[ "$routed" == "$expected_routed" ]] \
  || fail "ufw forwards '$routed', expected exactly '$expected_routed'"
pass "ufw forwards only traffic that starts on a container network"

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

# ── Docker answers to the firewall ───────────────────────────────────────────
# Docker no longer writes iptables rules, so ufw is the one thing deciding what
# reaches this host — and ufw has taken over the two jobs Docker's rules used to
# do: NAT for containers talking out, and forwarding between them. Each half of
# that is checked as behaviour, against a stand-in for the stack: a user-defined
# bridge network, which is what compose creates for a project, holding a web
# server that publishes a port no ufw rule mentions.
PROBE_IMAGE=python:3.13-alpine

# Rules Docker wrote are recognisable without knowing what Docker version wrote
# them: every one is in a DOCKER* chain, jumps to one, or names a bridge
# interface Docker made. ufw's own rules for containers name bridges too, but
# only by wildcard or inside ufw's chains (ufw-*), so they do not match.
docker_rules() {
  th_exec "iptables-save; ip6tables-save" \
    | grep -E '^:DOCKER|^-A ([^u]|u[^f]|uf[^w]).*(DOCKER|docker0|br-[0-9a-f]{12})' || true
}

start_probe() {
  th_exec "docker network inspect probe-net >/dev/null 2>&1 || docker network create probe-net" >/dev/null
  # unless-stopped, like every long-running service in the stack, so that it
  # comes back when the playbook restarts Docker.
  th_exec "docker run -d --name probe-web --restart unless-stopped --network probe-net \
             -p $DOCKER_BLOCKED_PORT:80 $PROBE_IMAGE python3 -m http.server 80" >/dev/null
}

# The four things containers need from the network, given a probe running.
check_container_networking() {
  local when="$1"

  # Docker's own iptables rules are what used to make a published port
  # reachable regardless of ufw. A container is running and publishing, so this
  # is the moment Docker would have written them.
  local rules
  rules="$(docker_rules)"
  [[ -z "$rules" ]] || fail "Docker has written iptables rules $when: $rules"
  pass "Docker has written no iptables or ip6tables rules $when, with a container publishing a port"

  # Inside the host the published port answers, which makes the refusal from
  # outside a firewall's answer rather than an absent listener's.
  await "the probe container's published port to answer on the host" \
    th_exec "curl -sS --max-time 5 -o /dev/null http://127.0.0.1:$DOCKER_BLOCKED_PORT/"
  if curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$DOCKER_BLOCKED_PORT/" 2>/dev/null; then
    fail "a container's published port $DOCKER_BLOCKED_PORT answers from outside the host $when, but no ufw rule allows it"
  fi
  pass "a container publishing unallowed port $DOCKER_BLOCKED_PORT is reachable inside the host and not outside $when"

  # By name, on the same network: the app reaching postgres and redis. This is
  # Docker's embedded DNS and the forwarding rule together.
  th_exec "docker run --rm --network probe-net $PROBE_IMAGE wget -q -O /dev/null -T 10 http://probe-web/" \
    || fail "a container cannot reach another on the same network by name $when"
  pass "containers on one network reach each other by name $when"

  # Out to the internet over HTTPS: the app and worker calling Stripe, the LLM
  # APIs and Resend. This is the masquerade rule ufw now carries. Docker's own
  # package host stands in, because provisioning already depends on reaching it.
  th_exec "docker run --rm --network probe-net $PROBE_IMAGE wget -q -O /dev/null -T 20 https://download.docker.com/" \
    || fail "a container cannot make an outbound HTTPS request $when"
  pass "containers make outbound HTTPS requests $when"
}

echo "==> Checking container networking under ufw"
th_exec "docker pull -q $PROBE_IMAGE" >/dev/null || fail "the host could not pull $PROBE_IMAGE"
start_probe
check_container_networking "after provisioning"
# Gone before the second run, so that it meets the host a deploy would.
th_exec "docker rm -f probe-web && docker network rm probe-net" >/dev/null

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

# ── Third run: a host provisioned before Docker was taken off iptables ───────
# Docker does not remove the rules it wrote when it is told to stop writing
# them, so a host provisioned by an earlier version of this playbook keeps its
# hole until something takes them out. Recreate that host — Docker managing
# iptables, a network and a published port made under it — and the playbook has
# to leave it exactly as closed as a fresh one.
#
# The address pool stays as the playbook set it. An old host would not have one,
# but the pool is the block Docker's defaults start in, so its networks were
# already inside it; what differs between the two hosts is only who writes the rules.
echo "==> Run 3: a host whose Docker still manages iptables"
th_exec "python3 - <<'PY'
import json
path = '/etc/docker/daemon.json'
config = json.load(open(path))
for key in ('iptables', 'ip6tables'):
    config.pop(key, None)
json.dump(config, open(path, 'w'), indent=2)
PY
systemctl restart docker"
start_probe
[[ -n "$(docker_rules)" ]] \
  || fail "Docker wrote no iptables rules even when allowed to, so run 3 would prove nothing"
await "the probe to be reachable from outside, as on an old host" \
  curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$DOCKER_BLOCKED_PORT/"
pass "the old host is recreated: Docker's rules are in place and the published port is open"

# Every run starts by probing whether root still answers, and on this host a
# refused root login is three strikes in fail2ban's ledger: run 2's probe and
# this one would be six, and the jail would ban this machine halfway through.
# So for this run alone the jail ignores the address it sees the check arrive
# from, which is the host's default gateway. The ledger is otherwise left as it
# was, for the fail2ban checks at the end.
CONTROL_IP="$(th_exec "ip route show default" | awk '{print $3; exit}')"
[[ -n $CONTROL_IP ]] || fail "could not work out the address the check reaches the host from"
th_exec "fail2ban-client set sshd addignoreip $CONTROL_IP" >/dev/null

run_playbook | tee "$TH_WORK/run3.log"
check_container_networking "on a host that used to let Docker manage iptables"

th_exec "fail2ban-client set sshd delignoreip $CONTROL_IP" >/dev/null

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
