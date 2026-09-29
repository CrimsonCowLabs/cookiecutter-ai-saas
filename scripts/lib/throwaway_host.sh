#!/usr/bin/env bash
# A throwaway host the Ansible playbooks can be run against for real.
#
# Sourced by scripts/check_provisioning.sh, scripts/check_deploy.sh and
# scripts/check_backups.sh. It is here rather than in any of them because they
# all need the same thing and the thing is fiddly: a privileged systemd
# container running a real sshd, reached over real SSH on a published port, not
# `docker exec`. That matters because the criteria those checks assert are about
# who can log in, what the firewall lets through, what a deploy does over a
# connection and whether a systemd timer fires — and a docker connection would
# prove none of it.
#
# What the container cannot stand in for is a reboot or a kernel of its own, so
# nothing that uses it may depend on either.
#
# Usage:
#
#     source "$(dirname "$0")/lib/throwaway_host.sh"
#     throwaway_host_require_tools
#     trap 'throwaway_host_stop; ...' EXIT
#     throwaway_host_start my-check 2222 8080:8080 8443:443
#     th_exec "systemctl is-active docker"
#     th_ssh someuser "sudo -n true"
#
# After throwaway_host_start:
#   TH_NAME        the container (and image) name
#   TH_WORK        a temp directory, removed by throwaway_host_stop
#   TH_KEY         an SSH private key root already trusts
#   TH_SSH_PORT    the port sshd answers on, published on 127.0.0.1
#   TH_INVENTORY   an Ansible inventory naming the host through that key
#   TH_SSH_BASE    ssh options with no key, for deliberately-wrong-key tests

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# Poll until a command succeeds. Everything here races something starting up.
# A minute is enough for a service on an already-built image; raise
# TH_AWAIT_TRIES before calling if what is being waited for includes pulling an
# image over the network.
await() {
  local what="$1"
  shift
  for _ in $(seq "${TH_AWAIT_TRIES:-60}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}

throwaway_host_require_tools() {
  command -v docker >/dev/null || fail "docker is required"
  command -v ansible-playbook >/dev/null \
    || fail "ansible-playbook is required (pip install ansible)"
}

# throwaway_host_start NAME SSH_PORT [HOST_PORT:CONTAINER_PORT ...]
throwaway_host_start() {
  TH_NAME="$1"
  TH_SSH_PORT="$2"
  shift 2

  TH_WORK="$(mktemp -d)"
  TH_KEY="$TH_WORK/id_check"
  TH_INVENTORY="$TH_WORK/inventory.ini"

  ssh-keygen -q -t ed25519 -N "" -f "$TH_KEY" -C "$TH_NAME"
  cp "$TH_KEY.pub" "$TH_WORK/authorized_keys"

  # Deliberately a plain sshd on a service, not Ubuntu's socket activation: it
  # is the shape most VPS images ship, and it exercises provision.yml's restart
  # handler. Under socket activation sshd re-reads its configuration per
  # connection, so the hardening lands there without the restart either way.
  cat > "$TH_WORK/Dockerfile" <<DOCKERFILE
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus openssh-server sudo python3 \\
      iproute2 iptables ca-certificates curl gnupg
RUN systemctl disable ssh.socket && systemctl enable ssh \\
 && printf 'Port $TH_SSH_PORT\\n' > /etc/ssh/sshd_config.d/10-port.conf \\
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 600 /root/.ssh/authorized_keys
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE

  echo "==> Building the test host image"
  docker build -q -t "$TH_NAME" "$TH_WORK" >/dev/null

  echo "==> Starting it"
  # Privileged with the host's cgroup namespace: systemd needs to manage units,
  # and ufw needs to write iptables rules.
  #
  # Both Docker state directories are volumes, so that the Docker the playbook
  # installs is not stacking an overlay filesystem on this container's — nested
  # overlayfs fails the mount with a bare "invalid argument". /var/lib/docker
  # alone is not enough on Docker 29, which keeps images in containerd's
  # snapshotter: without the second volume, images load and then no container
  # made from them can start.
  local publish=(-p "127.0.0.1:$TH_SSH_PORT:$TH_SSH_PORT")
  local mapping
  for mapping in "$@"; do
    publish+=(-p "127.0.0.1:$mapping")
  done
  docker run -d --name "$TH_NAME" \
    --privileged --cgroupns=host \
    --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --mount type=volume,dst=/var/lib/docker \
    --mount type=volume,dst=/var/lib/containerd \
    "${publish[@]}" \
    "$TH_NAME" >/dev/null

  # IdentitiesOnly, because the machine running this may have a loaded agent
  # and sshd stops after a handful of offers — which is Ansible's own behaviour
  # when the inventory names a key.
  TH_SSH_BASE=(-o BatchMode=yes -o StrictHostKeyChecking=no
               -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
               -o IdentitiesOnly=yes -o ConnectTimeout=5 -p "$TH_SSH_PORT")
  TH_SSH_OPTS=("${TH_SSH_BASE[@]}" -i "$TH_KEY")

  await "systemd to finish booting" throwaway_host_systemd_ready
  await "sshd to answer" ssh "${TH_SSH_OPTS[@]}" root@127.0.0.1 true

  cat > "$TH_INVENTORY" <<INVENTORY
[vps]
$TH_NAME ansible_host=127.0.0.1 ansible_port=$TH_SSH_PORT ansible_ssh_private_key_file=$TH_KEY ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
INVENTORY
}

throwaway_host_systemd_ready() {
  # "degraded" is a booted system with a failed unit, which a container always
  # has a couple of (udev, and anything wanting real hardware).
  docker exec "$TH_NAME" systemctl is-system-running 2>/dev/null \
    | grep -qE '^(running|degraded)$'
}

throwaway_host_stop() {
  echo "==> Tearing down"
  docker rm -f -v "${TH_NAME:-}" >/dev/null 2>&1 || true
  docker image rm -f "${TH_NAME:-}" >/dev/null 2>&1 || true
  rm -rf "${TH_WORK:-/nonexistent}"
}

# Run a command on the host over real SSH, as a named account.
th_ssh() { ssh "${TH_SSH_OPTS[@]}" "$1@127.0.0.1" "$2"; }

# Run a command on the host the short way, for assertions that are not about
# who can log in. Every refused login is a strike in fail2ban's ledger, and a
# check should not be the thing that trips the jail it just installed.
#
# -i so that a heredoc can be piped in, which is how a caller writes a file onto
# the host. It allocates no TTY, so it changes nothing for callers that pipe
# nothing.
th_exec() { docker exec -i "$TH_NAME" bash -c "$1"; }
