#!/usr/bin/env bash
# Prove that ansible/files/db-roles.sql gives a generated project the two
# Postgres roles issue #103 asks for, on a host that already exists as well as
# on a new one:
#
#   * the schema owner — migrations run as it, it owns the database and every
#     object in public and drizzle, and it is not a superuser either;
#   * the app role     — app, db-writer and ops connect as it; it can read
#     and write every table, including ones a later migration adds (default
#     privileges), and nothing else: not a superuser, no CREATE ROLE, no
#     COPY to or from programs or files, no DDL, nothing in drizzle, no way
#     into another database.
#
# Usage: scripts/check_db_roles.sh <generated-project-dir>
#
# Two scenarios run in one throwaway Postgres container, of the image the
# project's docker-compose.prod.yml runs in production:
#
#   upgrade — the project's migrations are applied as `postgres` first, so
#             everything is owned by the superuser exactly as on a host
#             deployed before #103. db-roles.sql then has to hand all of it
#             over, run again without complaint (with new passwords, which
#             must replace the old), and leave migrations as the owner a
#             no-op.
#   fresh   — an empty database: db-roles.sql first, then the migrations as
#             the owner from the start.
#
# Each scenario has its own pair of roles (roles are cluster-wide, and the
# fresh scenario has to meet roles that do not exist yet), which also lets the
# check prove one app role cannot connect to the other's database.
#
# The SQL is run exactly the way ansible/deploy.yml runs it: as postgres, on
# stdin, with the role names and passwords in psql's environment. The role
# names and passwords below are deliberately awkward — a hyphen, quotes, a
# backslash, a dollar — so a script that pasted them into SQL unquoted would
# break here rather than on someone's host.
#
# Only Postgres runs; the app is never built. drizzle-kit runs on this
# machine against the container's published port, so this needs node/npm and
# runs `npm ci` in the project. If the project has no migrations yet (the
# template ships none — `npm run db:generate` is a README step), they are
# generated for the run and removed again afterwards.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

PROJECT_DIR="${1:?usage: check_db_roles.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

command -v docker >/dev/null || fail "docker is required"
command -v npm >/dev/null || fail "npm is required"

DB_ROLES_SQL="$PROJECT_DIR/ansible/files/db-roles.sql"
[[ -f "$DB_ROLES_SQL" ]] || fail "no ansible/files/db-roles.sql in $PWD; regenerate the project from this template"
[[ -f docker-compose.prod.yml ]] || fail "no docker-compose.prod.yml in $PWD; point this at a generated project"

# drizzle.config.ts loads .env.local (or .env) itself, and a DATABASE_URL in
# there could point the migrations somewhere other than the container below.
for f in .env.local .env; do
  [[ -e "$f" ]] && fail "$PWD/$f exists and drizzle-kit would read it; run this against a fresh checkout"
done

# The image production runs, read out of the compose file rather than assumed,
# so the pgvector variant is checked against pgvector's image.
IMAGE="$(sed -n 's/^ *image: *\(postgres:[^ ]*\|pgvector\/pgvector:[^ ]*\) *$/\1/p' docker-compose.prod.yml | head -1)"
[[ -n "$IMAGE" ]] || fail "could not read the postgres image out of docker-compose.prod.yml"
case "$IMAGE" in pgvector/*) PGVECTOR=1 ;; *) PGVECTOR=0 ;; esac

PG="db-roles-check-$$-$RANDOM"
GENERATED_MIGRATIONS=0
cleanup() {
  echo "==> Tearing down"
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  if [[ "$GENERATED_MIGRATIONS" == 1 ]]; then rm -rf "$PROJECT_DIR/lib/db/migrations"; fi
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────────────

# psql_super <db> <sql>: as postgres, over the container's local socket.
psql_super() {
  docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -tA -U postgres -d "$1" -c "$2"
}

# psql_as <role> <password> <db> <sql>: as that role, over TCP to the
# container's own network address, so the password is really checked. The
# image's pg_hba.conf trusts the local socket *and* 127.0.0.1, and asks for a
# scram password only from everywhere else — which is where the app, the
# worker and db-writer connect from, in containers of their own.
psql_as() {
  docker exec -i -e PGPASSWORD="$2" "$PG" \
    psql -X -q -v ON_ERROR_STOP=1 -tA -h "$PG_IP" -U "$1" -d "$3" -c "$4"
}

# expect_ok <what> <role> <password> <db> <sql>
expect_ok() {
  local what="$1" out
  shift
  out="$(psql_as "$@" 2>&1)" || fail "$what: refused as $1 on $3: $out"
  pass "$what"
}

# expect_refused <what> <pattern> <role> <password> <db> <sql>
#
# Refused, and refused for the reason given: a statement that fails because
# the connection failed or the SQL is wrong proves nothing about privileges,
# so the error has to match <pattern> (an extended regex, case-insensitive).
expect_refused() {
  local what="$1" pattern="$2" out
  shift 2
  if out="$(psql_as "$@" 2>&1)"; then
    fail "$what: succeeded as $1 on $3, and should have been refused"
  fi
  grep -qiE -- "$pattern" <<<"$out" \
    || fail "$what: failed as $1 on $3, but not with /$pattern/: $out"
  pass "$what: refused"
}

# run_db_roles <db> <owner> <owner-password> <app> <app-password>
#
# The exact invocation ansible/deploy.yml uses: postgres, ON_ERROR_STOP, no
# psqlrc, the script on stdin, the four values in psql's environment.
run_db_roles() {
  docker exec -i \
    -e DB_OWNER_ROLE="$2" -e DB_OWNER_PASSWORD="$3" \
    -e DB_APP_ROLE="$4" -e DB_APP_PASSWORD="$5" \
    "$PG" psql -v ON_ERROR_STOP=1 -X --username postgres --dbname "$1" -f - <"$DB_ROLES_SQL"
}

# A DATABASE_URL drizzle-kit can parse, whatever is in the password.
urlencode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

# migrate <db> <role> <password>: the project's own migrations, as that role,
# the way scripts/migrate.sh runs them in the migrator image.
migrate() {
  local url
  url="postgresql://$(urlencode "$2"):$(urlencode "$3")@127.0.0.1:${PG_PORT}/$1"
  DATABASE_URL="$url" npx --no-install drizzle-kit migrate \
    || fail "drizzle-kit migrate failed as $2 on $1"
  echo  # drizzle-kit's spinner leaves the line open
}

applied_migrations() { psql_super "$1" 'select count(*) from drizzle.__drizzle_migrations'; }

# Objects in public or drizzle that the owner role does not own, extension
# members aside (CREATE EXTENSION vector's type and functions belong to the
# extension and stay with whoever created it), and types that only exist as
# part of something else (array and row types follow their element or table).
# Prints one line per object; empty means the owner has everything.
#
# not_owned_by <db> <owner>
not_owned_by() {
  docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -tA -U postgres -d "$1" -v owner="$2" <<'SQL'
with ns as (select oid from pg_namespace where nspname in ('public', 'drizzle')),
     me as (select oid from pg_roles where rolname = :'owner')
select 'schema drizzle, owned by ' || pg_get_userbyid(nspowner) from pg_namespace
  where nspname = 'drizzle' and nspowner not in (select oid from me)
union all
select format('relation %s, owned by %s', c.oid::regclass, pg_get_userbyid(c.relowner)) from pg_class c
  where c.relnamespace in (select oid from ns) and c.relowner not in (select oid from me)
    and not exists (select from pg_depend d where d.classid = 'pg_class'::regclass
                    and d.objid = c.oid and d.deptype = 'e')
union all
select format('type %s, owned by %s', t.oid::regtype, pg_get_userbyid(t.typowner)) from pg_type t
  where t.typnamespace in (select oid from ns) and t.typowner not in (select oid from me)
    and not exists (select from pg_depend d where d.classid = 'pg_type'::regclass
                    and d.objid = t.oid and d.deptype in ('e', 'i'))
union all
select format('routine %s, owned by %s', p.oid::regprocedure, pg_get_userbyid(p.proowner)) from pg_proc p
  where p.pronamespace in (select oid from ns) and p.proowner not in (select oid from me)
    and not exists (select from pg_depend d where d.classid = 'pg_proc'::regclass
                    and d.objid = p.oid and d.deptype = 'e');
SQL
}

# What both roles must never be able to do, and what the app role must and
# must not do, against one scenario's database.
#
# check_roles <db> <owner> <owner-pw> <app> <app-pw> <other-db>
check_roles() {
  local db="$1" owner="$2" owner_pw="$3" app="$4" app_pw="$5" other_db="$6" role pw

  for role in owner app; do
    if [[ $role == owner ]]; then role="$owner" pw="$owner_pw"; else role="$app" pw="$app_pw"; fi
    [[ "$(psql_as "$role" "$pw" "$db" 'select rolsuper from pg_roles where rolname = current_user')" == f ]] \
      || fail "$role is a superuser"
    pass "$role: rolsuper is false"
    expect_refused "$role: COPY ... TO PROGRAM" "pg_execute_server_program" \
      "$role" "$pw" "$db" "copy (select 1) to program 'true'"
    expect_refused "$role: COPY ... FROM a server file" "pg_read_server_files" \
      "$role" "$pw" "$db" "copy users from '/etc/passwd'"
    expect_refused "$role: COPY ... TO a server file" "pg_write_server_files" \
      "$role" "$pw" "$db" "copy (select 1) to '/tmp/db-roles-check'"
    expect_refused "$role: pg_read_file()" "permission denied for function pg_read_file" \
      "$role" "$pw" "$db" "select pg_read_file('/etc/passwd')"
    expect_refused "$role: CREATE ROLE" "permission denied to create role" \
      "$role" "$pw" "$db" "create role db_roles_check_intruder"
    expect_refused "$role: CREATE DATABASE" "permission denied to create database" \
      "$role" "$pw" "$db" "create database db_roles_check_intruder"
    expect_refused "$role: ALTER ROLE ... SUPERUSER" "permission denied to alter role|must have the SUPERUSER" \
      "$role" "$pw" "$db" "alter role current_user superuser"
    expect_refused "$role: connecting to another app's database" "permission denied for database|CONNECT privilege" \
      "$role" "$pw" "$other_db" "select 1"
    expect_refused "$role: connecting to the postgres maintenance database" "permission denied for database|CONNECT privilege" \
      "$role" "$pw" postgres "select 1"
  done

  # The app role, against every table and view in public — not only users —
  # so one the grants missed shows up by name.
  local table tables
  tables="$(psql_super "$db" "select format('%I', relname) from pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm') order by 1")"
  [[ -n "$tables" ]] || fail "$db has no tables in public; did the migrations run?"
  for table in $tables; do
    psql_as "$app" "$app_pw" "$db" "select count(*) from $table" >/dev/null \
      || fail "$app cannot SELECT from $table"
  done
  pass "$app: SELECT on every table and view in public ($(wc -w <<<"$tables" | tr -d ' ') of them)"

  expect_ok "$app: INSERT, UPDATE, SELECT ... FOR UPDATE and DELETE on users" "$app" "$app_pw" "$db" "
    begin;
    insert into users (email) values ('db-roles-check@example.com');
    update users set name = 'checked' where email = 'db-roles-check@example.com';
    select id from users where email = 'db-roles-check@example.com' for update;
    delete from users where email = 'db-roles-check@example.com';
    commit;"
  # lib/checkout.ts, lib/job-submission.ts and friends serialise on these.
  expect_ok "$app: transaction-scoped advisory locks" "$app" "$app_pw" "$db" \
    "begin; select pg_advisory_xact_lock(hashtextextended('db-roles-check', 0)); commit;"

  expect_refused "$app: CREATE TABLE in public" "permission denied for schema public" \
    "$app" "$app_pw" "$db" "create table public.db_roles_check_intruder (id int)"
  expect_refused "$app: CREATE SCHEMA" "permission denied for database" \
    "$app" "$app_pw" "$db" "create schema db_roles_check_intruder"
  expect_refused "$app: CREATE TEMP TABLE" "permission denied to create temporary tables" \
    "$app" "$app_pw" "$db" "create temp table db_roles_check_intruder (id int)"
  expect_refused "$app: ALTER TABLE users" "must be owner of table users" \
    "$app" "$app_pw" "$db" "alter table users add column db_roles_check int"
  expect_refused "$app: DROP TABLE users" "must be owner of table users" \
    "$app" "$app_pw" "$db" "drop table users"
  expect_refused "$app: TRUNCATE users" "permission denied for table users" \
    "$app" "$app_pw" "$db" "truncate users"
  expect_refused "$app: reading drizzle.__drizzle_migrations" "permission denied for schema drizzle" \
    "$app" "$app_pw" "$db" "select count(*) from drizzle.__drizzle_migrations"
  expect_refused "$app: deleting from drizzle.__drizzle_migrations" "permission denied for schema drizzle" \
    "$app" "$app_pw" "$db" "delete from drizzle.__drizzle_migrations"
  expect_refused "$app: SET ROLE to the owner" "permission denied to set role" \
    "$app" "$app_pw" "$db" "set role \"$owner\""

  if [[ "$PGVECTOR" == 1 ]]; then
    expect_ok "$app: the vector type" "$app" "$app_pw" "$db" "select '[1,2,3]'::vector <-> '[1,2,4]'::vector"
  fi

  # A later migration, written by the owner the way drizzle-kit migrate will
  # be: what it creates has to be usable by the app role without anyone
  # re-running db-roles.sql (default privileges), serial sequence included.
  expect_ok "$owner: creating a table, as a future migration would" "$owner" "$owner_pw" "$db" \
    "create table db_roles_check_future (id serial primary key, note text)"
  expect_ok "$app: INSERT, UPDATE, SELECT and DELETE on a table the owner made later" "$app" "$app_pw" "$db" "
    insert into db_roles_check_future (note) values ('new');
    update db_roles_check_future set note = 'changed';
    select count(*) from db_roles_check_future;
    delete from db_roles_check_future;"
  expect_ok "$owner: dropping it again" "$owner" "$owner_pw" "$db" "drop table db_roles_check_future"
}

# ── Bring up Postgres ────────────────────────────────────────────────────────
echo "==> Starting $IMAGE"
docker run -d --name "$PG" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=roles_upgrade \
  -p 127.0.0.1::5432 "$IMAGE" >/dev/null
PG_PORT="$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://')"
[[ -n "$PG_PORT" ]] || fail "could not read the port the container published"
PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG")"
[[ -n "$PG_IP" ]] || fail "could not read the container's address"
# Over TCP, not the socket: while the image initialises a new data directory
# it runs a temporary server on the socket only (see docker-compose.prod.yml's
# healthcheck), and the first real one would then hit the restart.
for _ in $(seq 60); do
  docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 1
done
docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres || fail "postgres never became ready"
pass "postgres is up on 127.0.0.1:$PG_PORT"

echo "==> Installing dependencies (frozen)"
npm ci --no-audit --no-fund

if ! ls lib/db/migrations/*.sql >/dev/null 2>&1; then
  echo "==> Generating migrations from the schema (removed again on exit)"
  [[ -e lib/db/migrations ]] || GENERATED_MIGRATIONS=1
  npx --no-install drizzle-kit generate >/dev/null || fail "drizzle-kit generate failed"
  ls lib/db/migrations/*.sql >/dev/null 2>&1 || fail "drizzle-kit generated no migration"
fi

psql_super postgres "create database roles_fresh" >/dev/null

# ── The script refuses what would hurt ───────────────────────────────────────
echo "==> Refusing dangerous or missing settings"
if out="$(run_db_roles roles_fresh some_owner pw postgres pw 2>&1)"; then
  fail "db-roles.sql accepted DB_APP_ROLE=postgres"
fi
grep -qi "db-roles.sql" <<<"$out" || fail "DB_APP_ROLE=postgres failed, but not with db-roles.sql's own refusal: $out"
[[ "$(psql_super postgres "select rolsuper from pg_roles where rolname = 'postgres'")" == t ]] \
  || fail "postgres lost superuser to a refused run"
pass "DB_APP_ROLE=postgres is refused and postgres is untouched"

if out="$(run_db_roles roles_fresh same pw same pw 2>&1)"; then
  fail "db-roles.sql accepted the same role as owner and app"
fi
grep -qi "db-roles.sql" <<<"$out" || fail "owner = app failed, but not with db-roles.sql's own refusal: $out"
pass "one role as both owner and app is refused"

if out="$(docker exec -i -e DB_OWNER_ROLE=o -e DB_OWNER_PASSWORD=p -e DB_APP_ROLE=a \
            "$PG" psql -v ON_ERROR_STOP=1 -X --username postgres --dbname roles_fresh -f - \
            <"$DB_ROLES_SQL" 2>&1)"; then
  fail "db-roles.sql ran without DB_APP_PASSWORD"
fi
grep -q "DB_APP_PASSWORD" <<<"$out" || fail "a missing DB_APP_PASSWORD failed, but without naming it: $out"
[[ -z "$(psql_super postgres "select rolname from pg_roles where rolname in ('o', 'a')")" ]] \
  || fail "a refused run still created roles"
pass "a missing DB_APP_PASSWORD is refused, naming it, and changes nothing"

# ── Upgrade: a host whose objects all belong to postgres ─────────────────────
U_OWNER="acme_owner"
U_OWNER_PW="own'er pw \$1 \\ end"
U_APP="acme-app"
U_APP_PW="app 'p@ss' \$\$ \\x"

echo "==> Upgrade: migrating as postgres, the way a pre-#103 host did"
if [[ "$PGVECTOR" == 1 ]]; then
  psql_super roles_upgrade "create extension vector" >/dev/null
fi
migrate roles_upgrade postgres postgres
before="$(applied_migrations roles_upgrade)"
[[ "$before" -ge 1 ]] || fail "no migrations were applied as postgres"
# The template's schema is tables, enums and serial/uuid ids today. Add, as
# postgres too, one of each other kind drizzle-kit can generate, so handing
# them over is exercised before a project's own migration first needs it — the
# identity column's sequence in particular, which ALTER SEQUENCE must leave to
# its table.
psql_super roles_upgrade "
  create sequence db_roles_check_seq;
  create table db_roles_check_ident (id int generated always as identity primary key);
  create view db_roles_check_view as select id from users;
  create materialized view db_roles_check_matview as select count(*) as n from users;
  create function db_roles_check_fn() returns int language sql as 'select 1';" >/dev/null
[[ -n "$(not_owned_by roles_upgrade "$U_OWNER")" ]] || fail "postgres owns nothing; the upgrade scenario is not set up"
pass "$before migration(s) applied as postgres, everything owned by it"

echo "==> Upgrade: running db-roles.sql"
run_db_roles roles_upgrade "$U_OWNER" "$U_OWNER_PW" "$U_APP" "$U_APP_PW" \
  || fail "db-roles.sql failed on an existing database"
left="$(not_owned_by roles_upgrade "$U_OWNER")"
[[ -z "$left" ]] || fail "not handed over to $U_OWNER by db-roles.sql: $(tr '\n' ';' <<<"$left")"
[[ "$(psql_super roles_upgrade "select pg_get_userbyid(datdba) from pg_database where datname = current_database()")" == "$U_OWNER" ]] \
  || fail "roles_upgrade is not owned by $U_OWNER"
pass "the database and everything in public and drizzle now belong to $U_OWNER"
if [[ "$PGVECTOR" == 1 ]]; then
  # Every member of the extension — its type, its functions, its operators —
  # looked up through pg_depend, whatever catalog it lives in.
  moved="$(psql_super roles_upgrade "
    select pg_describe_object(d.classid, d.objid, 0) from pg_depend d
      join pg_extension e on e.oid = d.refobjid and e.extname = 'vector'
     where d.deptype = 'e' and d.refclassid = 'pg_extension'::regclass
       and coalesce(
             (select proowner from pg_proc where d.classid = 'pg_proc'::regclass and oid = d.objid),
             (select typowner from pg_type where d.classid = 'pg_type'::regclass and oid = d.objid),
             (select oprowner from pg_operator where d.classid = 'pg_operator'::regclass and oid = d.objid),
             (select relowner from pg_class where d.classid = 'pg_class'::regclass and oid = d.objid),
             'postgres'::regrole) <> 'postgres'::regrole")"
  [[ -z "$moved" ]] \
    || fail "members of the vector extension were handed over; they stay with the superuser: $(tr '\n' ';' <<<"$moved")"
  pass "the vector extension's own objects stay with postgres"
fi

echo "==> Upgrade: running db-roles.sql again, with new passwords"
U_OWNER_PW_OLD="$U_OWNER_PW" U_APP_PW_OLD="$U_APP_PW"
U_OWNER_PW="changed 'owner' pw"
U_APP_PW="changed 'app' pw"
run_db_roles roles_upgrade "$U_OWNER" "$U_OWNER_PW" "$U_APP" "$U_APP_PW" \
  || fail "db-roles.sql failed the second time round"
pass "a second run succeeds"
for pair in "$U_OWNER:$U_OWNER_PW_OLD" "$U_APP:$U_APP_PW_OLD"; do
  expect_refused "${pair%%:*}: its old password" "password authentication failed" \
    "${pair%%:*}" "${pair#*:}" roles_upgrade "select 1"
done
expect_ok "$U_OWNER: its new password" "$U_OWNER" "$U_OWNER_PW" roles_upgrade "select 1"
expect_ok "$U_APP: its new password" "$U_APP" "$U_APP_PW" roles_upgrade "select 1"

echo "==> Upgrade: migrating as $U_OWNER"
migrate roles_upgrade "$U_OWNER" "$U_OWNER_PW"
[[ "$(applied_migrations roles_upgrade)" == "$before" ]] \
  || fail "migrating as $U_OWNER re-applied migrations ($before before, $(applied_migrations roles_upgrade) after)"
pass "migrations as $U_OWNER succeed and are a no-op"

# ── Fresh: a new host, roles first ───────────────────────────────────────────
F_OWNER="fresh_owner"
F_OWNER_PW="fresh owner 'pw'"
F_APP="fresh_app"
F_APP_PW="fresh app 'pw'"

echo "==> Fresh: running db-roles.sql on an empty database"
run_db_roles roles_fresh "$F_OWNER" "$F_OWNER_PW" "$F_APP" "$F_APP_PW" \
  || fail "db-roles.sql failed on an empty database"
pass "db-roles.sql sets up an empty database"
if [[ "$PGVECTOR" == 1 ]]; then
  # The extension needs a superuser, which migrations no longer run as, so
  # db-roles.sql creates it; a project's own migration enabling it then has to
  # be a no-op as the owner, and deploys keep re-running db-roles.sql over it.
  [[ "$(psql_super roles_fresh "select count(*) from pg_extension where extname = 'vector'")" == 1 ]] \
    || fail "db-roles.sql did not create the vector extension on the pgvector image"
  expect_ok "$F_OWNER: a migration's CREATE EXTENSION IF NOT EXISTS vector" "$F_OWNER" "$F_OWNER_PW" roles_fresh \
    "create extension if not exists vector"
  run_db_roles roles_fresh "$F_OWNER" "$F_OWNER_PW" "$F_APP" "$F_APP_PW" \
    || fail "db-roles.sql failed with the vector extension installed"
  pass "db-roles.sql creates the vector extension and re-runs cleanly over it"
else
  [[ "$(psql_super roles_fresh "select count(*) from pg_extension where extname = 'vector'")" == 0 ]] \
    || fail "db-roles.sql created a vector extension on an image without pgvector"
fi

echo "==> Fresh: migrating as $F_OWNER"
migrate roles_fresh "$F_OWNER" "$F_OWNER_PW"
[[ "$(applied_migrations roles_fresh)" -ge 1 ]] || fail "no migrations were applied as $F_OWNER"
left="$(not_owned_by roles_fresh "$F_OWNER")"
[[ -z "$left" ]] || fail "not owned by $F_OWNER after a fresh setup: $(tr '\n' ';' <<<"$left")"
pass "migrations as $F_OWNER create everything, owned by it"

# ── What each role can and cannot do ─────────────────────────────────────────
echo "==> Upgrade: what the roles can and cannot do"
check_roles roles_upgrade "$U_OWNER" "$U_OWNER_PW" "$U_APP" "$U_APP_PW" roles_fresh
echo "==> Fresh: what the roles can and cannot do"
check_roles roles_fresh "$F_OWNER" "$F_OWNER_PW" "$F_APP" "$F_APP_PW" roles_upgrade

echo "==> Database roles check passed ($IMAGE)"
