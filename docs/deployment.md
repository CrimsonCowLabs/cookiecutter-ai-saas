# Deployment guide

This covers taking a generated project from a fresh VPS to a running, backed-up
production instance: provisioning the host, deploying the stack, how secrets
are managed, how TLS is obtained, and how database backups work. For
environment variables, the Docker services, and everything about developing
the generated project day to day, see [README.md](../README.md).

## Provisioning

Deploying assumes a host that already has a deploy account, a firewall and a
container runtime. `ansible/provision.yml` is what puts them there. It is
separate from `ansible/deploy.yml` on purpose: it runs when a server is new and
almost never again, so a routine deploy never re-runs apt and firewall tasks.

```bash
pipx install ansible          # or pip install ansible
# put the server's address in ansible/inventory.ini, then:
ansible-playbook -i ansible/inventory.ini ansible/provision.yml
```

That is the whole procedure, and running it again is a no-op — CI asserts a
second run reports zero changes, so it is safe to re-run after editing a value
rather than applying the difference by hand.

The host needs to be Debian-family (Ubuntu LTS is what CI exercises) and to
answer as root over SSH with your key the first time — a stock cloud image does.
The playbook refuses to run against anything else rather than half-provisioning
it.

| Concern | What the playbook leaves |
|---------|--------------------------|
| Deploy account | A user named from `author_name`, key-only, passwordless sudo, in the `docker` group — the account `ansible/deploy.yml` logs in as |
| SSH | Key-only, no root login, no passwords, in `/etc/ssh/sshd_config.d/00-hardening.conf` |
| Firewall | `ufw`, governing every inbound port — containers' included: inbound denied by default; SSH, `80/tcp`, `443/tcp` and `443/udp` (HTTP/3) open; forwarding and NAT for container networks (see [The firewall and Docker](#the-firewall-and-docker)) |
| Intrusion banning | `fail2ban`: an sshd jail reading the journal, and two jails reading Caddy's access log that ban web probers from `80` and `443` (see [Banning probers](#banning-probers)) |
| Security updates | `unattended-upgrades`, restricted to security origins, no automatic reboot |
| Log rotation | `logrotate.timer`, the journal capped at 500M, Docker's json-file logs capped |
| Container runtime | Docker Engine and the compose plugin, from Docker's apt repository, with its iptables management off |
| Where deploys land | `/app/<project_slug>`, owned by the deploy account |

Everything adjustable is in `ansible/group_vars/all.yml` — the account name, the
open ports, the ban thresholds, the log caps — or overridable for one run with
`-e`.

### One command, before and after hardening

A fresh VPS answers as root; a provisioned one refuses to. The playbook probes
the host before connecting and uses whichever account currently answers, so the
command does not change between the first run and the tenth.

The order inside the run matters for the same reason: the deploy user is
created, given the key, and **observed logging in** before root's ability to log
in is removed. A wrong key fails while root still answers. That check is the one
thing you can turn off (`-e deploy_login_check=false`), and it exists to make
lockout hard.

### What it deliberately leaves alone

- **No reverse proxy.** Caddy runs inside the production stack (see
  [HTTPS and TLS](#https-and-tls)), so provisioning's part is to leave 80 and
  443 open and unoccupied. The playbook fails if a host nginx or Apache is
  running on them, rather than letting Caddy fail to bind on the first deploy.
- **No application.** Provisioning ends at a ready host; `ansible/deploy.yml`
  takes it from there.

### The firewall and Docker

ufw is the only thing deciding what the outside world can reach. That is not
Docker's default: left alone, Docker publishes a container's port by writing
its own iptables rules ahead of ufw's, so a published port is open to the
internet whatever ufw says. The playbook turns that off — `"iptables": false`
and `"ip6tables": false` in `/etc/docker/daemon.json`, written before Docker is
first started — so a port a container publishes is an ordinary listener
(`docker-proxy`) that ufw filters like any other. Publish a port in the compose
file and it is reachable from outside only once a ufw rule allows it.

Docker's rules also did two jobs the containers still need, so ufw does them
instead:

| Job | How ufw does it |
|-----|-----------------|
| Forwarding traffic out of container networks | `ufw route allow in on br-+` (every compose network) and `in on docker0` (the default bridge). Traffic *from* a container may go anywhere; traffic *to* one is forwarded only as a reply. Routed traffic is otherwise denied |
| NAT for containers talking to the internet | `/etc/ufw/after.init`, which ufw runs on every start, reload and stop. It masquerades traffic from `docker_address_pool` (in `group_vars/all.yml`, pinned in `daemon.json` so the two agree) that leaves the host, and leaves traffic between containers untranslated |
| The kernel forwarding at all | `net/ipv4/ip_forward=1` in `/etc/ufw/sysctl.conf` |

`ufw status verbose` shows the inbound rules and the two forwarding rules; the
NAT rule is in `iptables -t nat -S ufw-docker-postrouting`.

A host provisioned before this — where Docker did manage iptables — still
carries the rules Docker wrote, because Docker does not remove them when told to
stop. Re-running `provision.yml` removes them, leaving ufw's and fail2ban's
rules in place. CI checks both the fresh host and that upgrade: no Docker rule
in `iptables-save` or `ip6tables-save`, a container's published port refused
from outside while it answers on the host, containers reaching each other by
name and the internet over HTTPS — and a second run that changes nothing.

Two things follow for the stack, both in `docker-compose.prod.yml`:

- **Caddy runs on the host's network.** A published port now goes through
  `docker-proxy`, which would make every client arrive from the same Docker
  gateway address — one bucket for the contact form's per-IP rate limit, and
  nothing worth banning. On the host's network Caddy binds 80, 443 and 443/udp
  itself, sees each client's own address, and passes it to the app in
  `X-Forwarded-For`.
- **The app publishes its port on loopback** (`127.0.0.1:3000`), which is where
  Caddy proxies to. Nothing outside the host can reach it.

### Banning probers

Caddy already refuses scanner probes (see the `@scanner` matcher in the
`Caddyfile`), but refusing one costs the scanner nothing, so it keeps going. Two
`fail2ban` jails read Caddy's JSON access log on the host —
`/app/<project_slug>/logs/caddy/access.log`, bind-mounted out of the container —
and ban the address at the firewall instead, the way the sshd jail does for
failed logins:

| Jail | Counts | Never counts | Bans after (default) |
|------|--------|--------------|----------------------|
| `caddy-scanner` | lines Caddy marked `"blocked":"scanner"` — `/.env`, `/wp-login.php`, anything ending `.php` and the rest of `@scanner` | everything else | 3 in 10 minutes |
| `caddy-errors` | any 4xx answer, the proxy's 413 and 429 and the app's 429 included | `/api/webhook/stripe`, `/api/auth/callback/*` | 60 in 10 minutes |

The two exclusions are traffic whose failures are not hostile: Stripe retries a
failing webhook delivery for days from its own addresses, so banning it stops
billing; and a user whose OAuth redirect went wrong lands on a callback with bad
parameters and tries again. The errors threshold is high for the same reason —
it is there for a client hammering the app, not for a visitor who follows a few
dead links.

A ban drops the address's packets to `80/tcp`, `443/tcp` and `443/udp` and
nothing else. It is a DROP, not a reject, so a scanner gets a timeout per try
rather than a fast answer. SSH is left alone on purpose: an operator who bans
their own address — testing, or behind a shared office NAT — can still log in
and lift it. Every value is a variable in `ansible/group_vars/all.yml`, applied
by re-running `provision.yml`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `fail2ban_caddy_scanner_maxretry` | `3` | scanner probes before `caddy-scanner` bans |
| `fail2ban_caddy_errors_maxretry` | `60` | 4xx answers before `caddy-errors` bans |
| `fail2ban_caddy_findtime` | `10m` | the window both jails count within |
| `fail2ban_caddy_bantime` | `1h` | how long a ban lasts before it lifts itself |
| `fail2ban_ignoreip` | `[]` | addresses or CIDRs no jail ever bans — sshd's included — on top of loopback |

An address that legitimately makes a lot of failing requests — an uptime
checker, a load test, your office — belongs in `fail2ban_ignoreip`, rather than
in thresholds raised for everyone.

Seeing and lifting bans, on the host:

```bash
sudo fail2ban-client status caddy-scanner             # "Banned IP list" at the end
sudo fail2ban-client status caddy-errors
sudo fail2ban-client set caddy-scanner unbanip 203.0.113.7
sudo fail2ban-client unban 203.0.113.7                # from every jail, sshd's included
```

CI holds the jails to this as behaviour against a deployed stack
(`scripts/check_deploy.sh`): a burst of browsing, sign-in, unauthenticated
checkout, more bad OAuth callbacks and badly signed Stripe webhooks than the
errors threshold bans nobody; a client requesting scanner paths is banned, its
requests to 80 and 443 time out while SSH still answers it and everyone else is
still served; and once the ban time has passed it is served again.

## Deploying

`ansible/deploy.yml` builds the images, ships them, runs the migrations and
switches the stack over — one command, reading the host out of the same
inventory provisioning used:

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml                    # every secret the stack needs
ansible-vault encrypt ansible/vault.yml      # asks for a vault password
git add ansible/vault.yml                    # committed, encrypted

ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass
```

There is no address to fill in and no env file to copy: the address is
in the inventory and the env files are rendered on the host from the vault. Both
of those were how the shell script this replaces leaked secrets into shell
history.

| Instead of | Now |
|------------|-----|
| `./scripts/deploy.sh full` | `ansible-playbook -i ansible/inventory.ini ansible/deploy.yml` |
| `./scripts/deploy.sh app` | `... -e deploy_targets=app` |
| `./scripts/deploy.sh worker db-writer` | `... -e deploy_targets=worker,db-writer` |
| `./scripts/deploy.sh env` | `... -e deploy_targets=none` |
| — | `... -e deploy_targets=caddy` — the proxy's own image |
| — | `... --tags preflight` — check the vault and DNS, deploy nothing |

`migrator` is added to any non-empty `deploy_targets`, because the migrator
image already on the host belongs to the *previous* release: shipping new app
code and running the previous release's migrations against it is the failure
the ordering below exists to prevent. `-e run_migrations=false` skips running
them; nothing skips shipping the right image.

`caddy` is a target like the others because the proxy is an image this project
builds: stock Caddy has no rate limiter, so `caddy/Dockerfile` compiles one in
(see [Rate limits](#rate-limits)), and the deploy builds it, ships it under the
release tag and rolls it back exactly as it does the app. The `Caddyfile` is
still shipped beside the compose file and mounted into it, so a proxy-rule
change alone needs no rebuild.

A subset ships only what it names, and the compose file asks for every
service's image, so each has to be on the host already. On a host first
deployed while the proxy was still stock Caddy there is no `<slug>-caddy` image:
deploy with `caddy` in the set — the default includes it — once before
narrowing `deploy_targets`, or the switch fails and rolls back.

### The DNS pre-flight

Before anything is built, the playbook resolves the name the certificate will
be for (the domain, or `site_address` where that is set) and compares it with
the host the inventory points at. A mismatch aborts, saying what resolved, what
was expected and what to do.

That check is there because the certificate authority rate-limits **failed**
challenges, and Caddy asks for a certificate the moment it starts. Deploying
before a record propagates therefore does not cost one failed attempt — it can
lock issuance for that name for hours, on a host where nothing else is wrong.

It handles the cases that are not mistakes honestly:

- **The generation-time default** (`myapp.example.com`) aborts naming RFC 2606:
  no record can point it here and no CA will issue for it.
- **`site_address=https://localhost`** — smoke-testing the stack — skips the
  check and says so, because no public record covers a loopback name.
- **A record that is deliberately not the host** — proxied through a CDN, where
  the answer is the proxy's address — cannot be told apart from a record nobody
  updated. So the check says what it saw and stops, rather than claiming to
  have verified something: `-e dns_check=false` proceeds, and the message says
  what the proxy then has to pass through.

### Why the order is the guarantee

"A failed deployment leaves the previous version serving" is a property of
ordering, not of a rollback step. Everything that can fail happens before
anything changes what is serving:

1. **Pre-flight** — the vault, the record. Nothing built.
2. **Build, on the control machine.** A $5 VPS running the database has no
   business also running `next build`, and the host never needs the source.
3. **Ship** the compose file, the `Caddyfile`, the rendered env file and the
   new images — under a **release tag**, not `:latest`. The running containers
   hold their own images and their own copy of the env file, so none of this
   touches them. `template` replaces a file by renaming over it, which is why
   the running containers keep reading the copy they opened.
4. **Migrate**, from this release's migrator image, with Postgres and Redis up
   but the app not switched. First the [database roles](#database-roles) are
   created or brought up to date; then the migrations run as the schema owner.
   A failure in either stops the deploy here.
5. **Switch**: move each `:latest` tag and bring the stack up. If the
   switched-over stack does not answer, put the previous release's images back,
   restart on them, and fail loudly.

The release name defaults to a digest of the image ids rather than a timestamp,
so deploying unchanged code twice produces the same release instead of shipping
byte-identical images under a new name — which is what lets a re-run transfer
nothing and report no changes at all. `-e deploy_release=v1.4.0` names one
yourself.

Two things this does not claim. The switch is `docker compose up -d`, which
stops a container before starting its replacement, so a release that cannot
start costs the seconds between the recreate and the rollback — the guarantee
is the end state, not zero downtime. And the health gate proves the app boots
and answers on the host's loopback, not that TLS works: a certificate
arrives from an asynchronous ACME exchange that has not necessarily finished on
a first deploy, which is what the DNS pre-flight protects instead.

| Concern | Where it lives |
|---------|----------------|
| Secrets | `ansible/vault.yml`, encrypted; `ansible/vault.yml.example` documents every name |
| Non-secret settings | `ansible/group_vars/all.yml` |
| What compose interpolates | `ansible/templates/env-production.j2`, rendered to `/app/<slug>/.env-production` on the host, `0600`: the postgres superuser and Caddy's settings, handed to no container |
| Each service's environment | `ansible/templates/env-<service>.j2` for `app`, `worker`, `db-writer` and `ops`, rendered to `/app/<slug>/.env-<service>`, `0600`, each the `env_file` of that service alone (see [Which secret goes where](#which-secret-goes-where)) |
| The migrations' connection | `ansible/templates/env-migrations.j2`, rendered to `/app/<slug>/.env-migrations` on the host, `0600`, read by the migrator alone |
| The database roles | `ansible/files/db-roles.sql`, run on every deploy; their names in `ansible/group_vars/all.yml` |
| What is deployed | `/app/<slug>/RELEASE` on the host |
| Previous releases | still on the host, tagged `<slug>-<image>:<release>` |

`scripts/check_deploy.sh` is CI's end-to-end run of all of this against a
throwaway host, including deploying a deliberately broken release on top of a
working one and asserting the working one still answers.

## Secrets

`ansible/vault.yml` holds every production secret, encrypted with
`ansible-vault`, and is committed that way. `.gitignore` excludes the vault
*password* file (`.vault-pass`) and never the vault. Every variable in it is
prefixed `vault_`, so a secret is recognisable wherever it is used. Change one
with `ansible-vault edit ansible/vault.yml`, which never writes plaintext to
disk.

The playbook refuses to run if the vault's first line is not `$ANSIBLE_VAULT` —
an operator who copies the example and forgets the encrypt step gets a refusal,
not a successful deploy and a plaintext secret in a commit.

Be clear about what this buys, because it is not "the secrets never leave the
vault": `ansible-vault` decrypts on the **control machine**, in memory, and the
rendered env files (`.env-production`, one `.env-<service>` per service, and
`.env-migrations`) land on the host at mode `0600` owned by the deploy account. Nothing is at rest in plaintext anywhere else — not in the repository,
not in a shell history, not in a file on your laptop. The machine running the
deploy still holds the password and sees the values while it runs; it has to.

Non-secret settings — the domain, the origin NextAuth builds callbacks from,
feature flags — are in `ansible/group_vars/all.yml` and in the env templates
under `ansible/templates/`, in the clear, where they can be read in a diff.

### Which secret goes where

Each container is handed only what its own code reads, so that a compromise of
one service gives away that service's secrets rather than the account's. The
one that matters most is the worker: it runs a model's tool calls against URLs
users supply, which makes it the container most likely to end up running
something it should not. It holds no Stripe key, no `NEXTAUTH_SECRET` (which
would forge anybody's session), no OAuth secret and no database password — it
never connects to Postgres at all, and hands its results to db-writer over the
queue.

| File on the host | Template | Handed to | What is in it |
|------------------|----------|-----------|---------------|
| `.env-app` | `env-app.j2` | `app` | `NEXTAUTH_URL`, `NEXTAUTH_SECRET`; `GOOGLE_ID`, `GOOGLE_SECRET` and `MICROSOFT_ENTRA_ID_ID`, `_SECRET`, `_TENANT_ID` for the providers the project has; `DATABASE_URL` (the app role's), `REDIS_URL`; `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` with billing; `RESEND_API_KEY` when the project sends email; `POSTHOG_KEY`, `POSTHOG_HOST`, `POSTHOG_ASSETS_HOST` with analytics; `FEATURE_EMAIL_NOTIFICATIONS` |
| `.env-worker` | `env-worker.j2` | `worker` | `REDIS_URL`; `LLM_PROVIDER` and the answered provider's key (and, for Ollama and OpenRouter, its model and base URL); `RESEARCH_MAX_TOOL_CALLS`; `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT` |
| `.env-db-writer` | `env-db-writer.j2` | `db-writer` | `DATABASE_URL` (the app role's), `REDIS_URL` |
| `.env-ops` | `env-ops.j2` | `docker compose run ops` | `DATABASE_URL` (the app role's) |
| `.env-migrations` | `env-migrations.j2` | the migrator's `docker run`, and nothing else | `DATABASE_URL` (the schema owner's) |
| `.env-production` | `env-production.j2` | no container: compose's `--env-file`, interpolated into the compose file | `POSTGRES_USER`, `POSTGRES_PASSWORD` (the superuser's, for the postgres service); `SITE_ADDRESS` and the `CADDY_*_RATE_LIMIT_*` settings that are set, passed through to `caddy` |

By vault secret:

| Vault variable | Reaches |
|----------------|---------|
| `vault_nextauth_secret` | app |
| `vault_google_*`, `vault_microsoft_entra_id_*` | app |
| `vault_stripe_secret_key`, `vault_stripe_webhook_secret` | app |
| `vault_resend_api_key` | app |
| `vault_posthog_key` | app |
| `vault_<provider>_api_key` | worker |
| `vault_langsmith_api_key` | worker |
| `vault_postgres_app_password` | app, db-writer, ops (inside `DATABASE_URL`) |
| `vault_postgres_owner_password` | the migrator |
| `vault_postgres_password` | postgres, through compose's interpolation |
| `vault_backup_*` | the backup units `ansible/backup.yml` installs; no container |

A variable added to the code goes into the template of the service that reads
it, and nowhere else. `tests/deploy/service-env.test.mjs` in the generated
project (`npm run test:service-env`, run by CI for every flag combination)
fails when a service's file sets a name its code does not read — the worker's
code is `workers/app`, db-writer's `workers/db-writer`, ops's `lib/db`, the
migrator's `drizzle.config.ts` and the app's everything Next.js builds — when a
service reads a name the deploy renders for some other service but not for it,
when a compose service is handed any file but its own, and when
`.env-production` holds anything the compose file does not interpolate.
`scripts/check_deploy.sh` checks the same thing on a deployed host, from the
running containers' environments.

A one-off `docker compose run ops ...` that needs one of the app's keys is
given it for that run with `-e NAME=...`, rather than ops holding them all the
time.

## Database roles

In production the app does not connect to Postgres as `postgres`. A superuser
can do far more than the app ever needs: `COPY ... TO PROGRAM` runs a shell
command in the database container, and it can create roles and open any
database on the server. A SQL injection gets whatever its connection can do, so
the connection the app holds is now the least that serves it. There are three
roles:

| Role | Name | Who connects as it | What it can do |
|------|------|--------------------|----------------|
| Superuser | `postgres` | the role bootstrap, the nightly backup, a restore — all from inside the database container | anything |
| Schema owner | `<db>_owner` | the migrator, and nothing else | owns the database and everything in it, so migrations can create and alter tables. Not a superuser, cannot create roles or databases |
| App role | `<db>_app` | app, db-writer, and `docker compose run ops` (the worker does not connect to the database) | select, insert, update and delete rows in `public`, and use its sequences. No DDL, no roles, no databases, no `COPY` to or from programs or files, nothing in drizzle's migrations journal, no other database on the server |

`<db>` is the database name, the slug with dashes turned into underscores. The
names are `postgres_owner_user` and `postgres_app_user` in
`ansible/group_vars/all.yml`; choose them before the first deploy, because a
renamed role leaves the old one behind.

Each has its own password in the vault: `vault_postgres_password`,
`vault_postgres_owner_password` and `vault_postgres_app_password`. The deploy
refuses to run while any of them is empty. `DATABASE_URL` in `.env-app`,
`.env-db-writer` and `.env-ops` is the app role's. The owner's is in
`.env-migrations`, which is the migrator's whole environment and nobody else's:
the owner's password in a service's file would be in that service's
environment.

Every deploy runs `ansible/files/db-roles.sql` as the superuser before the
migrations. It runs whatever is being shipped, `-e deploy_targets=none`
included. It creates whichever role is missing, sets both passwords from the
vault, gives the database and everything in `public` and `drizzle` to the
owner, and grants the app role what it needs. It also sets default privileges,
so a table a later migration creates can be used by the app with no grant of
its own. It is idempotent and runs in one transaction. A failure stops the
deploy before anything is switched, with the previous release still serving.
Because it sets both passwords every time, rotating either one is a vault edit
and a deploy. The superuser's password is still the exception: Postgres only
reads it when it initialises the data directory, so changing it needs an
`ALTER ROLE` as well.

Only `public` is covered. A migration that creates a schema of its own leaves
the app role without access to it until the script grants that too.

On the pgvector variant the script also runs `CREATE EXTENSION IF NOT EXISTS
vector`. pgvector is not a trusted extension, so only a superuser can create
it, and migrations no longer run as one. A migration of your own that enables
it should say `IF NOT EXISTS`, and then finds it already there.

`POSTGRES_USER` and `POSTGRES_PASSWORD` are in `.env-production`, because
compose interpolates the postgres service's settings from that file. No
container but Postgres's own is handed them: `.env-production` is the
`--env-file` compose reads, not any service's `env_file`. Nothing in the stack
connects with them.

Local development (`docker-compose.yml`, `.env.example`) still connects as the
`postgres` superuser. Its database is on your machine and holds nothing worth
protecting, and keeping it simple means `npm run db:migrate` and the app share
one `DATABASE_URL`.

### Upgrading a host deployed before #103

A host deployed before the roles existed runs the app as `postgres`, and
`postgres` owns every table. Upgrading it is a vault edit and a deploy. Nothing
is done in the database by hand:

```bash
ansible-vault edit ansible/vault.yml
# add, each set to its own `openssl rand -hex 32`:
#   vault_postgres_owner_password: "..."
#   vault_postgres_app_password: "..."

ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass
```

A deploy with the old vault is refused before anything is built. The message
names the two missing passwords and says this is all the upgrade needs. On the
deploy that follows, the bootstrap creates both roles and hands the database,
every table, sequence and enum, and drizzle's journal to the owner. Then the
migrations run as the owner, and the switch brings the app, worker and
db-writer up on the app role's `DATABASE_URL`. The previous release keeps
serving as `postgres` until that switch. If the switch fails, the rollback
brings the previous release back on the app role. That works, because the roles
and grants are already in place.

`scripts/check_deploy.sh` checks this path. It puts a deployed host back to how
deploys used to leave it, checks that the old vault is refused, and checks
that the next deploy leaves the roles exactly as a fresh one does.

## HTTPS and TLS

TLS needs no step of its own. The stack runs its own Caddy, generated from the
`domain_name` you answered, which obtains a certificate from Let's Encrypt on
first boot, renews it, and redirects HTTP to HTTPS — so once the stack is up,
HTTPS is up. There is no external proxy to stand up and no network to create by
hand.

Bringing the stack up still means what it did before: `docker-compose.prod.yml`
has no build context, so `ansible/deploy.yml` builds the images and ships them,
and `.env-production` and each service's `.env-<service>` have to exist next to
the compose file or compose aborts — which is why the playbook renders them
there. Nothing about the proxy changes that.

Two prerequisites for the certificate, and neither is optional:

- **Point the domain's A/AAAA record at the host before the first deploy.**
  Issuance is a challenge against that name, so it fails until DNS resolves and
  ports 80 and 443 reach the host. Caddy retries with a backoff, so fixing
  DNS afterwards recovers without intervention — but Let's Encrypt rate-limits
  failures, so the record is cheaper to get in first.
- **Set `nextauth_url` to `https://<your domain>` in `ansible/group_vars/all.yml`**
  (it becomes `NEXTAUTH_URL` in `.env-app`; the default is already the
  `domain_name` you answered), and register
  that origin's OAuth callback URLs with your providers. Caddy sets
  `X-Forwarded-Proto`, which is what lets NextAuth (`trustHost: true`) build
  `https://` callbacks — but the configured origin still has to match.

| Concern | Where it lives |
|---------|----------------|
| Proxy config | `Caddyfile`, rendered from `domain_name` at generation time |
| Proxy image | `caddy/Dockerfile` — Caddy with the rate-limit module; deploy target `caddy` |
| Rate limits | `caddy_*rate_limit_*` in `ansible/group_vars/all.yml`; empty means the `Caddyfile`'s defaults (see [Rate limits](#rate-limits)) |
| Certificates | the `caddydata` volume — keep it across deploys, or every boot re-issues into a rate limit |
| Expiry warnings | mailed to `author_email`, unless that is at a reserved example domain (see below) |
| Listening ports | `80`, `443`, `443/udp` (HTTP/3), bound by `caddy` on the host's network; the app's `3000` on `127.0.0.1` only, for Caddy |

Postgres and Redis publish no port, and nothing from outside is forwarded to a
container, so they are reachable only from the host and from inside the stack.
That is less isolation than there used to be: Caddy once sat on a network of its
own with the app, with no route to the database, and on the host's network it
has the host's routes, which reach every container's address. A compromised
Caddy could connect to Postgres (which still wants its password) and Redis
(which has none). Host networking is the price of Caddy seeing clients' real
addresses — see [The firewall and Docker](#the-firewall-and-docker).

The same goes for other compose projects on the same host. Docker used to keep
its networks apart with isolation chains of its own; with its iptables
management off, `ufw route allow in on br-+` forwards from any container network
to any destination, the other networks' containers included. On a host that runs
only this stack that changes nothing. If you add unrelated stacks, give Redis a
password, or keep them on another host.

Responses are not compressed at the proxy. Next.js already compresses its own
output, and compressing a stream is how the SSE job-progress endpoint stops
arriving live.

### Rate limits

Caddy limits the requests one client address may make — a generous limit across
the site, a tighter one on the endpoints that cost something per request, one
of its own for the analytics proxy, and one for the Stripe webhook, which is
kept out of the site-wide budget — and answers a request over any of them with
`429` and `Retry-After`. That 429 is in the access log, where the
`caddy-errors` jail counts it like any other 4xx (the webhook's excepted, as
the jail ignores that path).

The first three are set without touching the `Caddyfile`: it reads each from
the environment, with its own default for when it is unset. The webhook's, 300
a minute, is fixed in the `Caddyfile`, since it follows Stripe's delivery rate
rather than your traffic.

| `group_vars/all.yml` | Environment Caddy reads | Means |
|----------------------|-------------------------|-------|
| `caddy_rate_limit_events` | `CADDY_RATE_LIMIT_EVENTS` | requests per window, site-wide |
| `caddy_rate_limit_window` | `CADDY_RATE_LIMIT_WINDOW` | that window, as a Go duration (`30s`, `1m`) |
| `caddy_strict_rate_limit_events` | `CADDY_STRICT_RATE_LIMIT_EVENTS` | requests per window on the strict endpoints |
| `caddy_strict_rate_limit_window` | `CADDY_STRICT_RATE_LIMIT_WINDOW` | that window |
| `caddy_ingest_rate_limit_events` | `CADDY_INGEST_RATE_LIMIT_EVENTS` | requests per window to the analytics proxy (`/ingest`) |
| `caddy_ingest_rate_limit_window` | `CADDY_INGEST_RATE_LIMIT_WINDOW` | that window |

All six are empty by default. The deploy writes only the ones you set into
`.env-production`, beside `SITE_ADDRESS`, and the compose file passes each
through to the `caddy` service — so an unset one is unset inside Caddy too, and
its default applies. Changing one is `-e deploy_targets=none`; nothing is
rebuilt. An office or carrier NAT puts many people behind one address, so lower
the site-wide limit only once the access log has shown you what normal looks
like.

`scripts/check_deploy.sh` checks this on a real deploy: the running proxy is
the release's `<slug>-caddy` image with `http.handlers.rate_limit` in it, none
of them reaches it until one is set, and setting `caddy_rate_limit_events=5`
turns a burst from one client into 429s.

### Smoke-testing before DNS exists

`SITE_ADDRESS` overrides the name Caddy serves. Set it to `https://localhost` and
Caddy issues from its own local CA instead of asking Let's Encrypt for a name
that does not resolve yet:

```bash
SITE_ADDRESS=https://localhost docker compose -f docker-compose.prod.yml up -d
curl -k https://localhost/
```

Everything else — the redirect, TLS termination, the proxy hop — is the
production path; only the issuer differs, so this proves the wiring and not the
ACME exchange. The compose file runs pre-built images, so the app's and the
proxy's (`docker build -t <slug>-caddy:latest caddy`) have to be built first.
CI's `tls-stack` job runs exactly this, via `scripts/check_tls_stack.sh`.

### If `author_email` is at a reserved example domain

The ACME account address comes from `author_email`. A certificate authority can
reject an address it cannot deliver to, so a project generated with an address no
mail can reach ships **no** `email` directive at all. Certificates are still
issued; the account is just anonymous, which means nobody is told when renewal
starts failing.

"Unreachable" is the set RFC 2606 reserves: the `example.com`, `example.org` and
`example.net` domains, and the `.test`, `.invalid`, `.localhost` and `.example`
TLDs. It is the mail domain that is tested, not a suffix, so a real domain like
`acme-example.com` keeps its account. Add a global block to the `Caddyfile` once
you have a real address:

```caddyfile
{
    email you@your-real-domain.com
}
```

## Database backups

**Restore is not automated.** There is no `restore.sh` and no playbook that puts
a dump back. What this ships is the half that has to happen unattended — dumps
taken on a schedule, copied somewhere the host is not, pruned on a policy, and
loud when they fail. Putting one back is a handful of commands you run
deliberately, with the site down, having decided which dump to use:

```bash
# 1. Fetch the dump you want. `rclone lsl backup:<bucket>/<prefix>` lists them,
#    newest last; the name is the UTC time it was taken.
sudo rclone --config /etc/<slug>-db-backup/rclone.conf \
  copyto backup:<bucket>/<prefix>/db-20250104T033012Z.dump /tmp/restore.dump

# 2. Stop everything that writes. A restore into a live database is how you get
#    a database that is neither the old one nor the new one.
cd /app/<slug> && docker compose -f docker-compose.prod.yml \
  --env-file .env-production stop app worker db-writer

# 3. Restore, as the superuser. --clean --if-exists drops what is there first,
#    so this is a replacement and not a merge. No --no-owner: the dump records
#    the schema owner as the owner of everything and the app role's grants, and
#    keeping them is what lets the next migration alter these tables.
docker exec -i <slug>-postgres-1 pg_restore \
  --clean --if-exists -U postgres -d <slug_with_underscores> \
  < /tmp/restore.dump

# 4. From your own machine, deploy without shipping anything. This runs the
#    role bootstrap over what was restored and brings the stack back up.
#    Check the data before you let traffic in.
ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass \
  -e deploy_targets=none
```

The restore needs the [database roles](#database-roles) to exist, because the
dump assigns its objects to them. On a host that is already deployed they do.
On a fresh host, provision it and deploy once first, which creates the roles,
and then restore. Step 4 fixes ownership and grants whichever way they came out
of the dump. A dump taken before the roles existed has everything owned by
`postgres` and has no app-role grants, and the bootstrap hands it all to the
owner just as it does in an [upgrade](#upgrading-a-host-deployed-before-103).
`--no-owner` would have the same effect on a current dump, so it is not
dangerous. It is left out because it throws away ownership the dump already
has right.

The reason that is four commands in a README rather than a script is that an
untested restore script is worse than none: it reads as a guarantee, and the day
you find out it does not work is the day you needed it. Run the steps above
against a throwaway database once, before you need them.

### Setting them up

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml            # where the dumps go, and where alerts go
ansible-vault encrypt ansible/vault.yml
ansible-playbook -i ansible/inventory.ini ansible/backup.yml
sudo systemctl start <slug>-db-backup.service    # on the host: take the first one now
```

Run it after the stack is up — the dump comes out of the running Postgres
container, so a schedule installed against a stack that has never existed is a
schedule that fails. Running it again is a no-op; CI asserts that a second run
reports zero changes.

Commit the encrypted `ansible/vault.yml`. It is ciphertext, and keeping it in
the repository is what stops the only copy of those credentials from living on
whichever laptop ran the playbook last. The password that opens it goes in
`ansible/.vault-pass`, which `.gitignore` already excludes; point Ansible at it
with `export ANSIBLE_VAULT_PASSWORD_FILE=ansible/.vault-pass`, or pass
`--ask-vault-pass`. The playbook refuses to run against a `vault.yml` that is
not encrypted, rather than quietly reading your storage credentials out of a
plaintext file nobody has noticed yet.

Two values are required, and the playbook refuses to install a schedule without
either:

- **`vault_backup_remote` and `vault_backup_remote_path`** — where the dumps go.
  A dump that only ever lands on the machine being backed up is not a backup, so
  "unconfigured" is a refusal and not a quiet fall back to local-only.
- **`vault_backup_alert_url`** — where a failure goes. Without it the only
  record of a broken backup is a journal entry on the broken host, which nobody
  reads. See [When they break](#when-they-break).

Two more refusals happen before the host is touched, because both failures
otherwise present as a nightly alert rather than as a mistake to fix now. A
destination that cannot outlive the host — rclone's `local`, `alias` or `memory`
backends, or an endpoint on the loopback — is rejected, which is a floor rather
than a guarantee: an endpoint naming a host that happens to resolve back is
indistinguishable from a real one at install time, and the playbook says so. And
the *source* is verified as well as the destination: if no running Postgres
container carries the stack's Compose label, the playbook refuses rather than
installing a schedule that fails every night from the first one.

### What gets installed

| Concern | What the playbook leaves |
|---------|--------------------------|
| The dump | `pg_dump --format=custom`, run **inside** the Postgres container — the only client on the host that cannot be older than the server, and the database publishes no port for anything else to connect to |
| Schedule | `<slug>-db-backup.timer`, daily at 03:30 UTC with up to 45 minutes of jitter, `Persistent=true` so a missed run happens at the next boot |
| Off-host copy | `rclone` to whatever `vault_backup_remote` names — any S3-compatible bucket, or any other rclone backend, without the playbook changing |
| Verification | The archive has to parse as one (`pg_restore --list`), and the destination has to read back at the same size, before anything is pruned |
| Retention | 7 dumps locally, 30 at the destination |
| Failure | `OnFailure=` → a POST to `vault_backup_alert_url`, a journal entry at priority `err`, and a marker file at `/var/lib/<slug>-backup/FAILED` |
| Staleness | `<slug>-db-backup-watch.timer`, every six hours, failing (and so alerting) when the last success is more than 30 hours old |
| Credentials | `/etc/<slug>-db-backup/rclone.conf`, mode 0600, root-owned |
| Dumps | `/var/backups/<slug>`, mode 0700 — a dump is the whole database, including every token in it |

Everything adjustable is in `ansible/group_vars/all.yml` — the schedule, the
retention numbers, the staleness limit, the alert payload's shape — or
overridable for one run with `-e`.

`rclone` comes from the distribution's package rather than a binary fetched at
install time, so it receives security updates through the `unattended-upgrades`
that [provisioning](#provisioning) already configured, and no version is
pinned in this template to go stale. The trade is a release that lags
upstream; if you need a backend or a flag it does not have, install a newer
`rclone` by hand and the playbook will leave it alone.

### The retention policy

**7 local, 30 remote.** The local copy is a convenience — it makes a same-day
restore fast and survives nothing — so it is deliberately shorter than the
destination's, which is the copy that outlives the host. At a dump a day that is
a week on the box and a month off it.

Two rules make the policy safe rather than merely small:

- **Nothing is pruned until a backup has been verified at the destination.** The
  upload has to have happened and the object has to read back at the right size.
  A run that fails deletes nothing — a half-working backup that still prunes is
  how a retention policy comes to eat the last good copy.
- **The newest dump can never be pruned.** Dumps are named for the UTC second
  they were taken, so sorting the names sorts by time, and the prune only ever
  looks past the newest *N*. The playbook additionally refuses to install a
  policy of zero, and the script refuses to run under one.

Both ends of that are asserted in CI against a real destination: an old dump is
deleted, the newest is not, locally and remotely.

### When they break

A systemd timer whose service fails writes to the journal and stops there, and
the journal is a complete record that nobody reads unprompted — which is why a
timer that has been failing for a month looks exactly like one that has never
failed. So a failure is reported three ways, with different failure modes:

1. **A POST to `vault_backup_alert_url`**, the only one of the three that
   reaches somebody who was not already looking. Anything that accepts a POST
   works — a Slack, Discord or Mattermost incoming webhook, or an ntfy.sh topic.
   `backup_alert_payload` in `group_vars/all.yml` is the body, with `%MESSAGE%`
   substituted; the default shape is Slack's.
2. **A journal entry at priority `err`**, so `journalctl -t <slug>-db-backup -p err`
   finds it without your having to know which unit to ask about.
3. **A marker file**, `/var/lib/<slug>-backup/FAILED`, removed by the next
   successful backup — so its presence means "broken now", not "broke once".

And separately, the case none of that catches: backups that simply stopped.
Nothing failed, so nothing reported. `<slug>-db-backup-watch.timer` runs every
six hours, fails when the last success is more than 30 hours old, and routes to
the same alert. It is a dead-man's switch, so while backups are stale you will
hear about it four times a day, deliberately — a nag is how an alert survives a
busy week.

To see the state by hand:

```bash
cat /var/lib/<slug>-backup/last-success      # when, which dump, how big
systemctl list-timers '<slug>-db-backup*'    # when next, when last
journalctl -u <slug>-db-backup.service -n 50
```

Set `vault_backup_heartbeat_url` as well if you want the one thing an on-host
check cannot give you. It is pinged after every successful backup, for a
dead-man's-switch service (healthchecks.io, Cronitor, an Uptime Kuma push
monitor) that alerts when the pings stop. The staleness timer covers a schedule
that stopped firing; it cannot report a host that is powered off, out of disk or
destroyed, because by then nothing on it runs.

### What this does not cover

- **Restore, as above.** Practise it before you need it.
- **Anything but Postgres.** Redis holds the job queue and the `caddydata`
  volume holds certificates. Losing the queue costs in-flight jobs; losing the
  certificates costs a re-issue, and Let's Encrypt rate-limits those.
- **Encryption at rest beyond the destination's own.** The dump is uploaded as
  `pg_dump` wrote it, so what protects it is the bucket's access control and the
  provider's server-side encryption. If you need the destination unable to read
  it, add an `rclone` crypt remote — and then keep that key somewhere other than
  the host it encrypts, or the backup is unreadable in exactly the case it
  exists for.
- **A credential that cannot delete.** Pruning needs delete, so the credential
  on the host has it, which means a compromised host can empty the bucket. Scope
  the credential to that one bucket, and turn on object lock or versioning if
  your provider offers it.

## Operating a deployed instance

Every generated project ships `opsctl`, a small CLI so that running a deployed
instance is not a matter of remembering `docker compose` invocations over SSH.
It reads the host out of `ansible/inventory.ini` and
`ansible/group_vars/all.yml` — the files provisioning and deploying already
read — so there is exactly one place the host is configured, and it
authenticates by shelling out to your own `ssh`: your `~/.ssh/config`, your
agent and your `known_hosts`, not a key or identity the CLI manages itself.

```bash
npm ci        # builds the CLI as a side effect (the `prepare` script)
npm link      # optional: puts `opsctl` on PATH
opsctl        # no arguments: lists every command
```

| Command | What it does |
|---------|--------------|
| `opsctl config` | First-run check: is a host configured, is the vault encrypted, does it answer over SSH. Warns about legal settings in `config.ts` still left as placeholders. Observes only |
| `opsctl status` | Container status on the host (`docker compose ps`) |
| `opsctl logs <service>` | Logs from the host; arguments pass straight through, so `-f` follows |
| `opsctl shell <service>` | An interactive shell in a running service (`docker compose exec -it`) |

Those four are read-only, by design. The rest change the host, by wrapping the
same playbooks documented above rather than reimplementing them — there is
still exactly one deployment code path, whether a human types the
`ansible-playbook` command or `opsctl` does:

| Command | What it does |
|---------|--------------|
| `opsctl provision [-- ansible args]` | [Provisions](#provisioning) the host (`ansible-playbook ansible/provision.yml`); everything after `--` passes through, e.g. `-e deploy_public_key_file=...` |
| `opsctl deploy [targets...] [--no-migrate]` | [Deploys](#deploying) (`ansible-playbook ansible/deploy.yml`); `opsctl deploy` ships everything, `opsctl deploy app worker` ships a subset, `--no-migrate` is `-e run_migrations=false` |
| `opsctl migrate` | Runs pending migrations and ships nothing else (`-e deploy_targets=migrator`) — deploy.yml's own way to ship one image, aimed at the one that runs migrations |
| `opsctl secrets edit` | `ansible-vault edit ansible/vault.yml`, interactively, in your own `$EDITOR` — never decrypted to disk |
| `opsctl backup` | Takes a backup right now: `systemctl start <slug>-db-backup.service` on the host, the schedule [already installed](#database-backups) |
| `opsctl preflight` | `opsctl config`'s checks, then `ansible-playbook ansible/deploy.yml --tags preflight` — catches unresolved DNS, an unreachable host and missing configuration before a deploy does |

`opsctl provision`, `deploy`, `migrate` and `preflight` all run on the control
machine, exactly like typing the `ansible-playbook` command by hand — only
`backup` connects over SSH, because it starts something the playbooks already
put on the host rather than running a playbook itself. Extra `ansible-playbook`
arguments to `deploy` or `migrate` go after a literal `--` (`opsctl deploy app
-- -e dns_check=false`), so a flag's own value can never be mistaken for a
deploy target.

There is no `restore` command, deliberately: `opsctl restore` says so and
points at [Database backups](#database-backups)'s restore steps, which are a
manual procedure and stay one — see that section for why.

Full usage docs live in the generated project's own README (under "The CLI"),
since that is where the CLI actually runs — this is the template's side of the
same feature.
