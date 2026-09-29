#!/usr/bin/env bash
# Install the generated backup playbook on a throwaway host and prove what the
# backups do.
#
# Usage: scripts/check_backups.sh <generated-project-dir>
#
# Three containers, and that they are three is the point:
#
#   * the application host — scripts/lib/throwaway_host.sh's: a privileged
#     systemd container running a real sshd, reached over real SSH. The criteria
#     here are about systemd timers firing, a real journal and a real outbound
#     network, and a `docker` connection would prove none of them. It is taken to
#     a ready state by ansible/provision.yml, because "a provisioned host" is
#     exactly ansible/backup.yml's contract, and running the real playbook is
#     less code here than reimplementing a deploy account and a container
#     runtime — as well as proof that the two compose.
#   * the destination — a MinIO server standing in for S3-compatible object
#     storage, in its own container with its own filesystem and network
#     namespace. Every assertion about what arrived there is made from a *third*
#     container (MinIO's own `mc` client), never from the host being backed up,
#     so "the dump left the host" is read from the far side of a network hop.
#   * the alert endpoint — a small HTTP sink that records what is POSTed to it,
#     so "the failure reached somebody" is an assertion about a request that
#     left the host rather than about a log line on it.
#
# What the stand-in does not prove: durability. MinIO here shares a kernel and a
# disk with the host it is backing up, so this shows a dump crossing a network
# to somewhere the backup host cannot reach through its own filesystem — not
# that the copy survives the machine. It also does not exercise a real
# provider's credentials, its rate limits, or object lock.
#
# All three containers sit on Docker's default bridge and are addressed by IP,
# not by name. A user-defined network would give them DNS, but the application
# host runs a Docker daemon of its own, and the embedded resolver at 127.0.0.11
# depends on nat rules in the container's own namespace that both an inner
# dockerd and ufw rewrite. The default bridge hands the container the runner's
# resolver instead, which is what lets the inner Docker pull the Postgres image.
#
# This writes ansible/vault.yml into the project directory, so it refuses to run
# against a tree that already has one — point it at a freshly generated project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/throwaway_host.sh
source "$SCRIPT_DIR/lib/throwaway_host.sh"

PROJECT_DIR="${1:?usage: check_backups.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

throwaway_host_require_tools

# Longer than the harness's default minute, because what this waits for includes
# pulling the Postgres and MinIO images over the network.
TH_AWAIT_TRIES=120

# An `x && fail` one-liner would be wrong: under `set -e` an AND-list whose left
# side fails takes the whole script down, so a *missing* vault would abort here.
VAULT=ansible/vault.yml
if [[ -e $VAULT ]]; then
  fail "$PROJECT_DIR/$VAULT exists; this check would overwrite it. Run it against a freshly generated project."
fi

# Published on the same port the inventory names, for the reason
# check_provisioning.sh gives: the playbook opens that port in the firewall, and
# a translation would lock this check out of its own host.
SSH_PORT=2223
HOST="backup-check-host-$$"
MINIO="backup-check-minio-$$"
SINK="backup-check-sink-$$"

# Credentials for the stand-in destination. Not secret — nothing outside this
# machine can reach it — but they do travel through the vault, because the vault
# is one of the things being tested.
AK=backupcheckkey
SK=backupchecksecret
BUCKET=backups

cleanup() {
  # The two stand-ins are this script's; the application host, its image and the
  # temp directory are the harness's.
  docker rm -f -v "$MINIO" "$SINK" >/dev/null 2>&1 || true
  rm -f "$PROJECT_DIR/$VAULT"
  throwaway_host_stop
}
trap cleanup EXIT

# ── What the generated project decided ───────────────────────────────────────
# Read out of the generated tree rather than re-derived here, which is only the
# same thing until somebody changes one of them. The retention numbers are read
# because the criterion is "a documented policy, applied": the policy is
# whatever group_vars says, and that it is obeyed is what this script proves.
VARS=ansible/group_vars/all.yml
[[ -f $VARS ]] || fail "no $VARS in $PROJECT_DIR — is this a generated project?"
read_var() { sed -n "s/^$1: *//p" "$VARS" | head -1 | tr -d '"'; }
DEPLOY_USER="$(read_var deploy_user)"
APP_DIR="$(read_var app_dir)"
KEEP_LOCAL="$(read_var backup_keep_local)"
KEEP_REMOTE="$(read_var backup_keep_remote)"
MAX_AGE_HOURS="$(read_var backup_max_age_hours)"
[[ -n $DEPLOY_USER && -n $APP_DIR && -n $KEEP_LOCAL && -n $KEEP_REMOTE && -n $MAX_AGE_HOURS ]] \
  || fail "could not read the deploy user, app dir or retention policy out of $VARS"

# The project as the playbooks name it. Read rather than derived from app_dir:
# deploy.yml passes compose `-p {{ project_slug }}`, and backup_compose_project
# follows the same variable, so reading anything else here would make this check
# agree with the playbooks only for as long as app_dir happens to end in the slug.
SLUG="$(read_var project_slug)"
[[ -n $SLUG ]] || fail "could not read project_slug out of $VARS"
# The same names group_vars/all.yml derives, spelled out rather than read: a
# rename inside the playbook that this script does not know about should show up
# as a missing unit, not as an assertion that passes vacuously.
UNIT="$SLUG-db-backup"
LOCAL_DIR="/var/backups/$SLUG"
STATE_DIR="/var/lib/$SLUG-backup"
RCLONE_CONF="/etc/$UNIT/rclone.conf"
REMOTE_PATH="$BUCKET/$SLUG"

# The database name is the project slug with dashes replaced. Read from the
# compose file rather than re-derived from the directory, as
# scripts/check_tls_stack.sh does.
DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.prod.yml | head -1)"
[[ -n $DB_NAME ]] || fail "could not read POSTGRES_DB out of docker-compose.prod.yml"

# What makes "the dump is not empty" an assertion about data rather than about a
# file size.
SENTINEL="sentinel-row-3f9a2c"

echo "==> Backups for '$SLUG': unit $UNIT, keeping $KEEP_LOCAL local / $KEEP_REMOTE remote"

# ── A host to install backups on ─────────────────────────────────────────────
# Before the stand-ins, because the harness creates the temp directory the sink's
# script is written into.
echo "==> Building and starting the application host"
throwaway_host_start "$HOST" "$SSH_PORT"

# ── The destination, and somewhere for alerts to land ────────────────────────
echo "==> Starting the stand-in destination and the alert sink"
docker run -d --name "$MINIO" \
  -e "MINIO_ROOT_USER=$AK" -e "MINIO_ROOT_PASSWORD=$SK" \
  minio/minio server /data >/dev/null

# Records every request, so an alert is asserted as a request that arrived
# somewhere else rather than as a log line on the host that sent it. 204 with no
# body: it keeps `curl -f` happy and says nothing a client might parse.
cat > "$TH_WORK/sink.py" <<'SINK'
import http.server
import pathlib

LOG = pathlib.Path("/tmp/received.log")


class Handler(http.server.BaseHTTPRequestHandler):
    def _record(self, verb, body=""):
        with LOG.open("a") as handle:
            handle.write("%s %s %s\n" % (verb, self.path, body.replace("\n", " ")))
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self._record("POST", self.rfile.read(length).decode("utf-8", "replace"))

    def do_GET(self):
        self._record("GET")

    def log_message(self, *args):
        pass


LOG.touch()
http.server.HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
SINK
docker run -d --name "$SINK" -v "$TH_WORK/sink.py:/sink.py:ro" \
  python:3-alpine python /sink.py >/dev/null

# .NetworkSettings.Networks.bridge, not the top-level .NetworkSettings.IPAddress:
# Docker 29 dropped the latter, and the former has been there throughout.
container_ip() {
  docker inspect -f '{{ .NetworkSettings.Networks.bridge.IPAddress }}' "$1"
}
MINIO_IP="$(container_ip "$MINIO")"
SINK_IP="$(container_ip "$SINK")"
[[ -n $MINIO_IP && -n $SINK_IP ]] || fail "the destination or the sink has no address on the bridge"

# Every read of the destination goes through this: MinIO's own client, in its own
# throwaway container, which has never had access to the backup host's
# filesystem. MC_HOST_<alias> configures the alias from the environment, so
# nothing has to be written into the container.
mc() {
  docker run --rm -e "MC_HOST_d=http://$AK:$SK@$MINIO_IP:9000" \
    --entrypoint /usr/bin/mc minio/mc --quiet "$@"
}
await "the destination to accept connections" mc mb --ignore-existing "d/$BUCKET"

# Dump names at the destination, oldest first. `mc ls` prints the name last.
remote_dumps() {
  mc ls "d/$REMOTE_PATH/" 2>/dev/null | awk '{ print $NF }' \
    | grep -E '^db-.*\.dump$' | sort || true
}
remote_count() { remote_dumps | wc -l | tr -d ' '; }

sink_log() { docker exec "$SINK" cat /tmp/received.log; }
sink_lines() { sink_log | wc -l | tr -d ' '; }

pass "the destination and the alert sink are up, on $MINIO_IP and $SINK_IP"

printf 'backup-check-vault-password\n' > "$TH_WORK/vault-pass"
run_backup() {
  ansible-playbook -i "$TH_INVENTORY" ansible/backup.yml \
    --vault-password-file "$TH_WORK/vault-pass" "$@"
}

# ── Criterion: the vault has to be there, and encrypted ──────────────────────
# Checked while the host is still booting, which is the point: the refusal comes
# from the control machine, before anything is touched. A vault filled in and
# left in plaintext is the mistake worth catching loudly — the run would
# otherwise work, and the credentials for the only copy of the database that
# outlives this host would be sitting in the repository awaiting a `git add`.
echo "==> Refusing to run without an encrypted vault"
if run_backup > "$TH_WORK/no-vault.log" 2>&1; then
  fail "the playbook ran with no ansible/vault.yml at all"
fi
grep -q "does not exist" "$TH_WORK/no-vault.log" \
  || fail "a missing vault produced no message naming it: $(tail -3 "$TH_WORK/no-vault.log")"
pass "a missing vault is refused, with a message saying how to make one"

cat > "$VAULT" <<VAULTFILE
---
vault_backup_remote:
  type: s3
  provider: Minio
  endpoint: http://$MINIO_IP:9000
  region: us-east-1
  access_key_id: $AK
  secret_access_key: $SK
vault_backup_remote_path: $REMOTE_PATH
vault_backup_alert_url: http://$SINK_IP:8080/alert
vault_backup_heartbeat_url: http://$SINK_IP:8080/heartbeat
VAULTFILE

if run_backup > "$TH_WORK/plain-vault.log" 2>&1; then
  fail "the playbook ran against a plaintext ansible/vault.yml"
fi
grep -q "is not encrypted" "$TH_WORK/plain-vault.log" \
  || fail "an unencrypted vault was not refused by name: $(tail -3 "$TH_WORK/plain-vault.log")"
pass "an unencrypted vault is refused before the host is touched"

ansible-vault encrypt --vault-password-file "$TH_WORK/vault-pass" "$VAULT" >/dev/null
head -1 "$VAULT" | grep -q '^\$ANSIBLE_VAULT' || fail "ansible-vault did not encrypt $VAULT"

# ── Take the host to the state backup.yml expects ────────────────────────────
echo "==> Provisioning the host (ansible/provision.yml)"
ansible-playbook -i "$TH_INVENTORY" ansible/provision.yml > "$TH_WORK/provision.log" 2>&1 \
  || { tail -40 "$TH_WORK/provision.log" >&2; fail "provisioning the host failed"; }
pass "the host is provisioned: $DEPLOY_USER, Docker and $APP_DIR"

echo "==> Bringing up the stack's database and putting a row in it"
docker cp docker-compose.prod.yml "$TH_NAME:$APP_DIR/docker-compose.prod.yml" >/dev/null
docker cp Caddyfile "$TH_NAME:$APP_DIR/Caddyfile" >/dev/null
# Only what Postgres needs in order to boot. None of it is a real credential,
# and nothing else in the stack is on the path a backup takes.
th_exec "cat > $APP_DIR/.env-production" <<ENV
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
ENV
# Run from $APP_DIR with an explicit -p, exactly as deploy.yml does, so the
# containers carry the Compose project label backup_compose_project names. Left
# implicit, Compose would name the project after the directory, and this check
# would pass whether the playbook read project_slug or the directory — which is
# the confusion it exists to rule out.
th_exec "cd $APP_DIR && docker compose -p $SLUG -f docker-compose.prod.yml --env-file .env-production up -d --wait postgres" \
  > "$TH_WORK/stack.log" 2>&1 \
  || { tail -20 "$TH_WORK/stack.log" >&2; fail "could not bring up the stack's postgres on the host"; }

th_exec "cid=\$(docker ps -q --filter label=com.docker.compose.service=postgres | head -1);
  docker exec -i \$cid psql -v ON_ERROR_STOP=1 -U postgres -d '$DB_NAME' -c \"
    create table backup_check (id serial primary key, body text);
    insert into backup_check (body) values ('$SENTINEL');\"" >/dev/null \
  || fail "could not seed the database"
pass "the stack's postgres is running with a row in it"

# ── Criterion: a retention policy cannot be set to eat the last backup ───────
echo "==> Refusing a retention policy of zero"
if run_backup -e backup_keep_local=0 > "$TH_WORK/keep-zero.log" 2>&1; then
  fail "the playbook installed a schedule that keeps zero local backups"
fi
grep -q "have to be at least 1" "$TH_WORK/keep-zero.log" \
  || fail "keeping zero backups was not refused by name: $(tail -5 "$TH_WORK/keep-zero.log")"
pass "a retention policy that could delete the newest backup is refused"

# ── Criterion: the dumps have to leave this host ─────────────────────────────
# "Configured" is not the same claim as "off the host", so the obviously-local
# backends are refused outright. This is a floor and not a guarantee — an
# endpoint naming a host that resolves back here still passes, which the
# playbook's own comment says — but it catches the version of the mistake that
# looks like a working backup.
echo "==> Refusing a destination that is this host"
if run_backup -e '{"vault_backup_remote": {"type": "local"}}' \
     > "$TH_WORK/local-remote.log" 2>&1; then
  fail "the playbook installed a schedule writing its only copy to this host"
fi
grep -q "dies with the machine" "$TH_WORK/local-remote.log" \
  || fail "a same-host destination was not refused by name: $(tail -5 "$TH_WORK/local-remote.log")"
pass "a destination that cannot outlive this host is refused"

# ── Criterion: there has to be something to dump ─────────────────────────────
# The nightly script finds Postgres by its Compose labels, and a label matching
# nothing fails identically whether the stack is down or the project name is
# simply wrong. Unrefused, all of those arrive as an alert at 03:30 and then
# every night after, so the playbook turns them into a refusal while the
# operator is still watching.
echo "==> Refusing to schedule dumps of a database that is not there"
if run_backup -e backup_compose_project=no-such-stack \
     > "$TH_WORK/no-source.log" 2>&1; then
  fail "the playbook installed a schedule for a database it never found"
fi
grep -q "No running postgres container" "$TH_WORK/no-source.log" \
  || fail "a missing database was not refused by name: $(tail -5 "$TH_WORK/no-source.log")"
pass "a schedule with no database to dump is refused at install time"

# ── Install the backups ──────────────────────────────────────────────────────
echo "==> Run 1: installing backups"
run_backup > "$TH_WORK/run1.log" 2>&1 \
  || { tail -40 "$TH_WORK/run1.log" >&2; fail "installing backups failed"; }
pass "one command installed the backup schedule"

th_exec "command -v rclone" >/dev/null || fail "rclone is not installed on the host"

# Criterion: the dumps run on a schedule. The units are there, both timers are
# enabled so they survive a reboot, and both are loaded and waiting. That the
# timer then actually fires is a separate claim, asserted at the end.
for unit in "$UNIT.service" "$UNIT.timer" "$UNIT-watch.service" "$UNIT-watch.timer" \
            "$UNIT-alert@.service"; do
  th_exec "test -f /etc/systemd/system/$unit" || fail "$unit was not installed"
done
for timer in "$UNIT.timer" "$UNIT-watch.timer"; do
  th_exec "systemctl is-enabled $timer" >/dev/null || fail "$timer is not enabled"
  th_exec "systemctl is-active $timer" >/dev/null || fail "$timer is not running"
  next="$(th_exec "systemctl show -p NextElapseUSecRealtime --value $timer" | tr -d '\r')"
  [[ -n $next && $next != 0 ]] || fail "$timer has no next run scheduled"
done
pass "both timers are installed, enabled and waiting for their next run"

# ── Criterion: a dump is taken, and it leaves the host ───────────────────────
echo "==> Taking a backup"
th_exec "systemctl start $UNIT.service" \
  || { th_exec "journalctl -u $UNIT.service --no-pager -n 40" >&2; fail "the backup unit failed"; }

local_dumps() { th_exec "cd $LOCAL_DIR && ls -1 db-*.dump 2>/dev/null | sort" || true; }
local_count() { local_dumps | wc -l | tr -d ' '; }
newest_local() { local_dumps | tail -1; }

DUMP1="$(newest_local)"
[[ -n $DUMP1 ]] || fail "no dump in $LOCAL_DIR after the backup unit ran"

# Not empty, and a real archive: the two things a failed pg_dump redirected into
# a file would not be.
th_exec "test -s $LOCAL_DIR/$DUMP1" || fail "$DUMP1 is empty"
th_exec "head -c 5 $LOCAL_DIR/$DUMP1 | grep -q PGDMP" \
  || fail "$DUMP1 is not a Postgres custom-format archive"

# Restorable enough to prove it is not an empty shell: pg_restore turns the
# archive back into SQL and the seeded row is in it. This is what separates "a
# file was produced" from "the database was backed up".
th_exec "cid=\$(docker ps -q --filter label=com.docker.compose.service=postgres | head -1);
  docker exec -i \$cid pg_restore -f - < $LOCAL_DIR/$DUMP1" 2>/dev/null \
  | grep -q "$SENTINEL" \
  || fail "$DUMP1 does not contain the row that was in the database"
pass "the dump is a readable archive containing the database's rows"

# Criterion: the dump is at storage that is not the application host. Read
# through MinIO's client in a third container, so this is the far side of a
# network hop rather than the backup host reporting on itself.
remote_dumps | grep -qx "$DUMP1" || fail "$DUMP1 is not at the destination"
# Byte-for-byte, so that together with the pg_restore check above it is the
# *remote* copy that is known to contain the rows — without ever reading the
# remote copy back through the host being backed up.
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | awk '{ print $1 }'; }
remote_sha="$(mc cat "d/$REMOTE_PATH/$DUMP1" | sha256)"
local_sha="$(th_exec "sha256sum $LOCAL_DIR/$DUMP1" | awk '{ print $1 }')"
[[ "$remote_sha" == "$local_sha" ]] \
  || fail "the copy at the destination differs from the dump ($remote_sha vs $local_sha)"
pass "the dump arrived at the destination byte-for-byte"

# Criterion: at a glance, backups are still running.
th_exec "grep -q '$DUMP1' $STATE_DIR/last-success" \
  || fail "$STATE_DIR/last-success does not name the dump that was just taken"
sink_log | grep -q "GET /heartbeat" \
  || fail "no heartbeat ping reached the monitor after a successful backup"
pass "the success stamp names the dump, and the heartbeat monitor was pinged"

# The staleness watch has to pass on a fresh backup, or its failing later would
# prove nothing at all.
th_exec "systemctl start $UNIT-watch.service" \
  || fail "the staleness check fails even though a backup has just succeeded"
pass "the staleness check passes while backups are fresh"

# ── Criterion: old backups are pruned, and the newest never is ───────────────
# Enough dumps to push both limits over, named so they sort before any real one:
# see the timestamp format in the backup script, where the names are the clock,
# so lexicographic order is chronological order.
echo "==> Planting old dumps to push both retention limits over"
plant_local=$((KEEP_LOCAL + 2))
plant_remote=$((KEEP_REMOTE + 2))
th_exec "for i in \$(seq -w 1 $plant_local); do echo planted > $LOCAL_DIR/db-2020-\$i.dump; done"
th_exec "rm -rf /tmp/plant && mkdir -p /tmp/plant && cd /tmp/plant \
  && for i in \$(seq -w 1 $plant_remote); do echo planted > db-2020-\$i.dump; done \
  && rclone --config $RCLONE_CONF copy /tmp/plant backup:$REMOTE_PATH" \
  || fail "could not plant old dumps at the destination"

OLDEST_LOCAL="db-2020-$(printf "%0${#plant_local}d" 1).dump"
NEWEST_PLANTED_LOCAL="db-2020-$(printf "%0${#plant_local}d" "$plant_local").dump"
OLDEST_REMOTE="db-2020-$(printf "%0${#plant_remote}d" 1).dump"
NEWEST_PLANTED_REMOTE="db-2020-$(printf "%0${#plant_remote}d" "$plant_remote").dump"

echo "==> Taking a second backup, which should prune"
th_exec "systemctl start $UNIT.service" \
  || { th_exec "journalctl -u $UNIT.service --no-pager -n 40" >&2; fail "the second backup failed"; }
DUMP2="$(newest_local)"
[[ $DUMP2 != "$DUMP1" ]] || fail "the second run did not produce a new dump"

# Asserted first, because it is the only one of these whose failure cannot be
# undone: a retention policy that deletes the newest copy has destroyed the
# backup it was trimming behind. Everything else here is a policy that is the
# wrong shape, which is a bug you fix and re-run.
local_dumps | grep -qx "$DUMP2" || fail "pruning deleted the newest local dump"
remote_dumps | grep -qx "$DUMP2" || fail "pruning deleted the newest dump at the destination"
[[ "$(local_count)" == "$KEEP_LOCAL" ]] \
  || fail "$LOCAL_DIR holds $(local_count) dumps, expected exactly $KEEP_LOCAL"
[[ "$(remote_count)" == "$KEEP_REMOTE" ]] \
  || fail "the destination holds $(remote_count) dumps, expected exactly $KEEP_REMOTE"
# The other end of the policy: the oldest is actually gone, rather than the
# newest N being kept alongside everything else.
if local_dumps | grep -qx "$OLDEST_LOCAL"; then
  fail "$OLDEST_LOCAL was not pruned locally"
fi
if remote_dumps | grep -qx "$OLDEST_REMOTE"; then
  fail "$OLDEST_REMOTE was not pruned at the destination"
fi
local_dumps | grep -qx "$NEWEST_PLANTED_LOCAL" \
  || fail "pruning deleted $NEWEST_PLANTED_LOCAL, which is inside the retention window"
remote_dumps | grep -qx "$NEWEST_PLANTED_REMOTE" \
  || fail "pruning deleted $NEWEST_PLANTED_REMOTE, which is inside the retention window"
pass "pruning trims to $KEEP_LOCAL local / $KEEP_REMOTE remote, oldest first, newest untouched"

# The file the next prune would reach, if a run that failed were allowed to
# prune. Used below.
NEXT_TO_GO="$(local_dumps | grep '^db-2020-' | head -1)"
[[ -n $NEXT_TO_GO ]] || fail "could not work out which dump the next prune would delete"

# ── Criterion: a broken destination is a visible, non-destructive failure ────
# The destination is made unreachable from the host rather than stopped, so that
# it can still be read from `mc` while the host cannot reach it — and so the
# host keeps its route to the alert sink, which is the whole question here. ufw
# `reject` rather than `deny`: a refusal fails immediately, where a silent drop
# would only fail after rclone's connection timeout.
echo "==> Making the destination unreachable from the host"
before_remote="$(remote_count)"
before_stamp="$(th_exec "stat -c %Y $STATE_DIR/last-success" | tr -d '\r')"
th_exec "ufw reject out to $MINIO_IP" >/dev/null \
  || fail "could not cut the host's route to the destination"

if th_exec "systemctl start $UNIT.service" 2>/dev/null; then
  fail "the backup unit reported success with the destination unreachable"
fi
# pg_dump itself still works here, which is the point: this is specifically the
# criterion that an off-box copy is what makes a backup. No destination, no
# backup, however well the dump ran.
th_exec "systemctl is-failed $UNIT.service" >/dev/null \
  || fail "the backup unit is not in a failed state after failing"
pass "a dump that cannot leave the host is a failed backup, not a successful one"

# Where the failure is claimed to surface. Three places, because the journal on
# its own is a record nobody reads unprompted.
await "the alert to reach the endpoint" \
  docker exec "$SINK" grep -q "POST /alert" /tmp/received.log
alert="$(sink_log | grep 'POST /alert' | tail -1)"
grep -q "$UNIT.service" <<<"$alert" \
  || fail "the alert does not name the unit that failed: $alert"
grep -qi "failed" <<<"$alert" || fail "the alert does not say a backup failed: $alert"
th_exec "journalctl -t $UNIT -p err --no-pager | grep -qi 'FAILED'" \
  || fail "nothing was written to the journal at priority err"
th_exec "test -f $STATE_DIR/FAILED" || fail "no failure marker was left in $STATE_DIR"
pass "the failure reached the alert endpoint off the host, the journal at err, and a marker file"

# And it destroyed nothing. A half-working backup that still prunes is how a
# retention policy comes to eat the last good copy.
local_dumps | grep -qx "$NEXT_TO_GO" \
  || fail "the failed run pruned $NEXT_TO_GO; a run that cannot upload must not delete"
[[ "$(th_exec "stat -c %Y $STATE_DIR/last-success" | tr -d '\r')" == "$before_stamp" ]] \
  || fail "the failed run touched the success stamp, which is what the staleness check trusts"
[[ "$(remote_count)" == "$before_remote" ]] \
  || fail "the failed run changed the destination: $(remote_count) objects, was $before_remote"
pass "the failed run pruned nothing, locally or at the destination, and left the stamp alone"

echo "==> Restoring the route to the destination"
th_exec "ufw delete reject out to $MINIO_IP" >/dev/null \
  || fail "could not restore the host's route to the destination"
th_exec "systemctl start $UNIT.service" \
  || { th_exec "journalctl -u $UNIT.service --no-pager -n 40" >&2
       fail "the backup did not recover once the destination came back"; }
th_exec "test ! -f $STATE_DIR/FAILED" \
  || fail "the failure marker survived a successful backup, so it says nothing about now"
pass "a successful backup clears the failure marker"

# ── Criterion: a backup that silently stopped is not silent ─────────────────
# The failure mode OnFailure= cannot catch. Nothing fails, so nothing reports:
# the timer simply stopped firing and the last backup recedes into the past.
echo "==> Letting the last backup go stale"
lines_before="$(sink_lines)"
th_exec "touch -d '$((MAX_AGE_HOURS + 24)) hours ago' $STATE_DIR/last-success"
if th_exec "systemctl start $UNIT-watch.service" 2>/dev/null; then
  fail "the staleness check passed on a backup $((MAX_AGE_HOURS + 24)) hours old"
fi
await "the staleness alert to be delivered" \
  docker exec "$SINK" grep -q "$UNIT-watch.service" /tmp/received.log
stale_alert="$(sink_log | grep 'POST /alert' | tail -1)"
grep -q "$UNIT-watch.service" <<<"$stale_alert" \
  || fail "the staleness alert does not name the watch unit: $stale_alert"
[[ "$(sink_lines)" -gt "$lines_before" ]] \
  || fail "the staleness check failed without sending anything"
pass "a backup that quietly stopped raises an alert without anything having failed"

th_exec "touch $STATE_DIR/last-success"

# ── Idempotence ─────────────────────────────────────────────────────────────
echo "==> Run 2: re-running against the host"
run_backup > "$TH_WORK/run2.log" 2>&1 \
  || { tail -40 "$TH_WORK/run2.log" >&2; fail "the second run failed"; }
recap="$(grep -E 'ok=[0-9]+ +changed=' "$TH_WORK/run2.log" | tail -1)"
[[ -n $recap ]] || fail "no play recap in run 2's output"
if ! grep -qE 'changed=0 +unreachable=0 +failed=0' <<<"$recap"; then
  echo "--- tasks that reported a change on the second run ---" >&2
  grep -B3 '^changed:' "$TH_WORK/run2.log" >&2 || true
  fail "re-running the playbook changed something: $recap"
fi
pass "re-running the playbook changes nothing ($recap)"

# ── Criterion: the timer actually fires ─────────────────────────────────────
# Last, because it needs the schedule rewritten to something this check can wait
# for, and because a backup firing every minute would interfere with everything
# above. Installed, enabled and holding a next elapse was asserted earlier; that
# systemd then runs the thing is a different claim, and the one the criterion
# is actually about.
#
# The jitter has to come down with the schedule. RandomizedDelaySec applies to
# every elapse, so a per-minute timer still carrying the default 45 minutes of
# spread fires at a time nothing can wait for — which is correct in production,
# where the point is that a fleet of hosts does not arrive at one destination in
# the same second, and useless here.
echo "==> Run 3: a schedule this check can wait for, to prove the timer fires"
run_backup -e '{"backup_schedule": "*-*-* *:*:00", "backup_schedule_jitter": "1s"}' \
  > "$TH_WORK/run3.log" 2>&1 \
  || { tail -40 "$TH_WORK/run3.log" >&2; fail "reinstalling with a per-minute schedule failed"; }
th_exec "rm -f $STATE_DIR/last-success"
await "the timer to fire the backup with nobody starting it" \
  docker exec "$TH_NAME" test -f "$STATE_DIR/last-success"
pass "the timer fires the backup on its own"

echo "==> Backups check passed"
