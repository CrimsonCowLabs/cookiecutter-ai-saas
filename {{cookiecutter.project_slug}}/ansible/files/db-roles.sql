-- The two Postgres roles the stack runs as (issue #103), created or brought
-- back into line on every deploy.
--
--   DB_OWNER_ROLE  the schema owner. Migrations run as it, so it owns the
--                  database and everything in the public and drizzle schemas.
--                  It needs nothing more than that: it is not a superuser.
--   DB_APP_ROLE    what the app, the worker and db-writer connect as. It can
--                  read and write rows in public, and that is all: no DDL, no
--                  roles, no databases, no COPY to or from programs or files,
--                  nothing in drizzle, no other database on the server.
--
-- Before this, everything connected as `postgres`, so one SQL injection was a
-- shell in the database container (`COPY ... TO PROGRAM`). Now it is rows in
-- this one database the app could already reach.
--
-- Run by ansible/deploy.yml as the postgres superuser, connected to the app's
-- database, before migrations:
--
--     psql -v ON_ERROR_STOP=1 -X --username postgres --dbname "$POSTGRES_DB" -f -
--
-- with this file on stdin and DB_OWNER_ROLE, DB_OWNER_PASSWORD, DB_APP_ROLE and
-- DB_APP_PASSWORD in psql's environment (read below with \getenv, so a psql 15+
-- client — the stack's postgres:18 image has one). It is idempotent, and has
-- to be: it runs on a brand-new database, on a host deployed before #103 where
-- `postgres` owns everything, and on every deploy after that. Every run sets
-- each role's attributes and password from scratch, so changing a password in
-- the vault and deploying is how a password is rotated.
--
-- It all happens in one transaction: a run that fails part-way leaves the
-- database exactly as it found it, not with half its tables handed over.
--
-- Checked end to end by the template repository's scripts/check_db_roles.sh,
-- which CI runs against both variants of the template's Postgres image.

\set ON_ERROR_STOP on

-- The owner role can create functions and operators in public. Resolve every
-- name this superuser session uses in pg_catalog only, so nothing the owner
-- (or an injection that got as far as the owner) has defined there can stand
-- in for a built-in and run with superuser rights.
SET search_path = pg_catalog, pg_temp;

-- ── Inputs ──────────────────────────────────────────────────────────────────
-- An unset variable would otherwise be pasted into the SQL below as the
-- literal text ":'owner_role'" and fail with a baffling syntax error; say
-- which one is missing instead. (A psql \if branch cannot set an exit status
-- by itself, so each refusal is an exception, which ON_ERROR_STOP turns into
-- one.)
\getenv owner_role DB_OWNER_ROLE
\getenv owner_password DB_OWNER_PASSWORD
\getenv app_role DB_APP_ROLE
\getenv app_password DB_APP_PASSWORD

\if :{?owner_role}
\else
  DO $$ BEGIN RAISE EXCEPTION 'db-roles.sql: DB_OWNER_ROLE is not set in psql''s environment'; END $$;
\endif
\if :{?owner_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'db-roles.sql: DB_OWNER_PASSWORD is not set in psql''s environment'; END $$;
\endif
\if :{?app_role}
\else
  DO $$ BEGIN RAISE EXCEPTION 'db-roles.sql: DB_APP_ROLE is not set in psql''s environment'; END $$;
\endif
\if :{?app_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'db-roles.sql: DB_APP_PASSWORD is not set in psql''s environment'; END $$;
\endif

-- Values that are set but would do damage. The important one is a role this
-- script must never touch: everything below makes the named roles
-- NOSUPERUSER, so DB_APP_ROLE=postgres would take superuser away from the
-- very account that administers the server — and the one running this.
--
-- psql variables do not expand inside a DO $$ body, so the checks are plain
-- SQL, and a reason, if there is one, is turned into a DO that raises it via
-- \gexec. The message goes in with %L and is raised with USING MESSAGE, so
-- nothing in it is read as a format string or as SQL.
SELECT format('DO %L', format('BEGIN RAISE EXCEPTION USING MESSAGE = %L; END',
                              'db-roles.sql: ' || reason))
  FROM (SELECT CASE
          WHEN :'owner_role' = '' THEN 'DB_OWNER_ROLE is empty'
          WHEN :'app_role' = '' THEN 'DB_APP_ROLE is empty'
          WHEN :'owner_password' = '' THEN 'DB_OWNER_PASSWORD is empty'
          WHEN :'app_password' = '' THEN 'DB_APP_PASSWORD is empty'
          WHEN :'owner_role' = :'app_role'
            THEN 'DB_OWNER_ROLE and DB_APP_ROLE are the same role; the app role must not own the schema'
          WHEN :'owner_role' IN (current_user, session_user)
               OR :'app_role' IN (current_user, session_user)
               OR EXISTS (SELECT FROM pg_roles
                           WHERE oid = 10  -- the bootstrap superuser
                             AND rolname IN (:'owner_role', :'app_role'))
            THEN 'DB_OWNER_ROLE and DB_APP_ROLE must not name the superuser this runs as'
          WHEN :'owner_role' LIKE 'pg\_%' OR :'app_role' LIKE 'pg\_%'
            THEN 'role names starting pg_ are reserved for Postgres'' own roles'
        END AS reason) AS checks
 WHERE reason IS NOT NULL
\gexec

BEGIN;

-- The passwords go over the wire in ALTER ROLE below (hashed with scram by
-- the server before they are stored). Keep them out of the server log even if
-- someone has turned statement logging up, or a statement here fails and
-- Postgres would otherwise log it with the error.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = 'panic';

-- ── The roles ───────────────────────────────────────────────────────────────
-- Create whichever is missing, then set every attribute that matters on both,
-- every time: a role someone loosened by hand is tightened again on the next
-- deploy.
SELECT format('CREATE ROLE %I', r)
  FROM unnest(ARRAY[:'owner_role', :'app_role']) AS r
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r)
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
              ' NOREPLICATION NOBYPASSRLS VALID UNTIL ''infinity'' PASSWORD %L', r, p)
  FROM (VALUES (:'owner_role', :'owner_password'),
               (:'app_role', :'app_password')) AS v(r, p)
\gexec

-- Membership is how a non-superuser gets superuser-shaped powers: in
-- pg_execute_server_program (COPY ... TO/FROM PROGRAM), pg_read_server_files
-- and pg_write_server_files (COPY to and from files on the server),
-- pg_read_all_data and the like, or in a superuser role it could SET ROLE to.
-- Neither role needs to be a member of anything, so whatever membership
-- either has is revoked, whoever granted it. This script is the whole
-- definition of these two roles; anything extra an operator wants belongs to
-- a role of their own.
SELECT format('REVOKE %I FROM %I GRANTED BY %I',
              pg_get_userbyid(m.roleid), pg_get_userbyid(m.member), pg_get_userbyid(m.grantor))
  FROM pg_auth_members AS m
 WHERE pg_get_userbyid(m.member) IN (:'owner_role', :'app_role')
\gexec

-- ── The database ────────────────────────────────────────────────────────────
-- The owner role owns the database. That is what lets it create the drizzle
-- schema drizzle-kit keeps its migrations journal in, and — since Postgres 15
-- initialises public as owned by pg_database_owner — what makes it the owner
-- of public, free to create tables there, without any grant.
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'owner_role')
\gexec

-- Every role on the server can connect to a new database, and make temporary
-- tables in it, through PUBLIC. Take both away, then give the app role back
-- only CONNECT: an injection through it can then not open any other app's
-- database on this server, nor create even temporary objects. The owner keeps
-- both through owning the database; `postgres` is a superuser, which no grant
-- constrains, so backups and restores are unaffected.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC, %I', current_database(), :'app_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role')
\gexec

-- And the same PUBLIC grant taken off every other database that accepts
-- connections — the `postgres` maintenance database and template1 on a stack
-- that has nothing else — so "no other database on the server" holds for the
-- app role there too, not only for the databases this script was run in. Only
-- superusers use them; nothing in the stack connects to them as anyone else.
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database
 WHERE datallowconn AND datname <> current_database()
\gexec

-- ── Extensions ──────────────────────────────────────────────────────────────
-- pgvector's extension is not marked trusted, so only a superuser can create
-- it, and migrations no longer run as one: a project's own
-- `CREATE EXTENSION IF NOT EXISTS vector` migration would fail as the owner.
-- So it is created here, on the image that has it (the pgvector variant), and
-- such a migration finds it already there. On the stock image it is not
-- available and nothing happens.
SELECT 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public'
 WHERE EXISTS (SELECT FROM pg_available_extensions WHERE name = 'vector')
\gexec

-- ── Handing over what `postgres` made ───────────────────────────────────────
-- On a host deployed before #103 the migrations ran as `postgres`, which so
-- owns every table, enum and sequence; migrations as the owner role would then
-- fail on the first ALTER. Hand all of it over. (REASSIGN OWNED BY postgres
-- would be the one-liner, but Postgres refuses it for the bootstrap superuser,
-- whose objects include the system catalogs — hence the catalog walk.)
--
-- Anything in public or drizzle not already the owner's moves to it, not only
-- what a superuser owns, so a renamed DB_OWNER_ROLE hands over from the old
-- name too, and the app role is never left owning anything. Untouched:
--   * extension members — CREATE EXTENSION vector (the pgvector variant) puts
--     a type, operators and C-language functions in public that belong to the
--     extension. Postgres would let them be handed over, but they are a
--     superuser's to manage, through ALTER EXTENSION, and a non-superuser
--     owning C functions could ALTER them (into SECURITY DEFINER, say).
--   * sequences owned by a column (serial) or an identity: ALTER TABLE ...
--     OWNER takes them along, and ALTER SEQUENCE on one of them is an error.
--   * array types and the row type of each table, which follow their
--     element type or table; and indexes, which follow their table.
-- What drizzle-kit generates is covered: tables, enums, sequences, views,
-- materialized views, functions. Anything rarer a hand-written migration adds
-- (an operator, a text search configuration) is not, and stays with whoever
-- made it until handed over by hand.

-- public itself stays with pg_database_owner, i.e. whoever owns the database,
-- as Postgres 15+ creates it; this only puts back one that was handed elsewhere
-- (or came from a cluster initialised before 15).
SELECT 'ALTER SCHEMA public OWNER TO pg_database_owner'
  FROM pg_namespace
 WHERE nspname = 'public' AND nspowner <> 'pg_database_owner'::regrole
\gexec

SELECT format('ALTER SCHEMA drizzle OWNER TO %I', :'owner_role')
  FROM pg_namespace
 WHERE nspname = 'drizzle' AND pg_get_userbyid(nspowner) <> :'owner_role'
\gexec

-- Types first: enums, domains, standalone composite and range types. typtype
-- 'b' (base types, which only a superuser can create, and every array type)
-- and 'm' (multiranges, which follow their range) are left alone.
SELECT format('ALTER %s %s OWNER TO %I',
              CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
              t.oid::regtype, :'owner_role')
  FROM pg_type AS t
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
 WHERE n.nspname IN ('public', 'drizzle')
   AND pg_get_userbyid(t.typowner) <> :'owner_role'
   AND t.typtype IN ('e', 'd', 'c', 'r')
   -- A composite type that is really a table's row type follows the table.
   AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
   AND NOT EXISTS (SELECT FROM pg_depend AS d
                    WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid
                      AND d.deptype = 'e')
\gexec

SELECT format('ALTER %s %s OWNER TO %I',
              CASE c.relkind
                WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW'
                WHEN 'S' THEN 'SEQUENCE'
                WHEN 'f' THEN 'FOREIGN TABLE'
                ELSE 'TABLE'
              END,
              c.oid::regclass, :'owner_role')
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('public', 'drizzle')
   AND pg_get_userbyid(c.relowner) <> :'owner_role'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
   AND NOT EXISTS (SELECT FROM pg_depend AS d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                      AND d.deptype = 'e')
   -- 'a': owned by a serial column; 'i': an identity column's sequence.
   AND NOT (c.relkind = 'S' AND EXISTS (
         SELECT FROM pg_depend AS d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
\gexec

-- Functions, procedures and aggregates alike: ALTER ROUTINE covers all three.
SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, :'owner_role')
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'drizzle')
   AND pg_get_userbyid(p.proowner) <> :'owner_role'
   AND NOT EXISTS (SELECT FROM pg_depend AS d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                      AND d.deptype = 'e')
\gexec

-- ── Schemas ─────────────────────────────────────────────────────────────────
-- Postgres 15+ already withholds CREATE on public from PUBLIC; a cluster
-- initialised earlier, or a restored dump, may not. Make sure, so the app role
-- (which gets USAGE only) cannot create anything in public either way.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- drizzle holds the migrations journal. The app has no business reading it,
-- and an injection that could delete from it could make the next deploy
-- re-run old migrations. Nothing on it for anyone but its owner.
SELECT format('REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, %I', :'app_role')
  FROM pg_namespace WHERE nspname = 'drizzle'
\gexec

-- ── The app role's rows ─────────────────────────────────────────────────────
-- What it needs is exactly what the app, the worker and db-writer do: select,
-- insert, update and delete rows (FOR UPDATE row locks need UPDATE, which
-- this includes), take advisory locks (pg_advisory_xact_lock is open to
-- everyone), and draw ids from sequences. Nothing in them truncates, or runs
-- DDL at runtime — schema changes are migrations, which are the owner's — so
-- no TRUNCATE, REFERENCES or TRIGGER. Functions and types, enums included, are
-- usable by PUBLIC unless revoked, so need no grant here.
--
-- (`:"app_role"` is psql quoting the value as an identifier, the same as
-- format's %I; it is used where nothing else in the statement is dynamic.)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- And the same on whatever the owner creates in public from now on, so a
-- migration that adds a table does not also have to remember the grant, and
-- the app can use it the moment the migration has run — before this script
-- runs again on the next deploy.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";

COMMIT;
