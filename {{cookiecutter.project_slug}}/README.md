# {{ cookiecutter.project_name }}

{{ cookiecutter.project_description }}

## Agent Workflow

This project ships with `AGENTS.md` and `docs/agents/` conventions (issue
tracker, triage labels, domain docs) that the mattpocock-skills Claude Code
plugin reads to drive ticket intake, TDD, code review and other agentic
workflows against this stack. See
[Using the Matt Pocock skills plugin](docs/matt-pocock-skills.md) for which
skills to reach for and how each one maps to this template.

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19
- **Language:** TypeScript (strict), Python {{ cookiecutter.python_version }}
- **Styling:** Tailwind CSS 4 + DaisyUI 5
- **Database:** PostgreSQL 18, Drizzle ORM
- **Auth:** NextAuth v5 (JWT sessions, OAuth)
- **Queue:** BullMQ (Redis-backed)
{%- if cookiecutter.include_stripe == "yes" %}
- **Payments:** Stripe (subscriptions)
{%- endif %}
- **Email:** Resend
- **Deployment:** Docker Compose, Caddy reverse proxy (TLS in the stack)

## Getting Started

Run `./setup.sh` from the project root and it does the full job: it checks
Node.js and Docker are installed and running, writes both `.env.local` (host
mode) and `.env.docker.local` (container mode) from `.env.example`, generates
a `NEXTAUTH_SECRET`, prompts for credentials for whichever optional features
(Stripe, Google/Microsoft OAuth, Resend magic-link, your configured LLM
provider) survived generation, runs `npm ci`, brings up the Docker Compose
stack and waits for it to report healthy, generates and applies database
migrations, and finishes by printing how to start the dev server, the Python
worker, and the DB writer.

```bash
./setup.sh
```

### Prerequisites

- Node.js {{ cookiecutter.node_version }}+
- Python {{ cookiecutter.python_version }}+
- Docker & Docker Compose
- PostgreSQL 18
- Redis 7

### Manual setup

Prefer to do it by hand, or want to understand or customize what `./setup.sh`
automates? Here are the equivalent steps.

1. **Install dependencies:**

```bash
npm ci
```

2. **Configure environment:**

Two env files cover the two ways this project runs: `.env.local` for host
mode (`npm run dev`, services on `localhost`) and `.env.docker.local` for
container mode (`docker compose up`, services reached by their Docker
Compose service name instead of `localhost`). Both start from
`.env.example`.

```bash
cp .env.example .env.local
cp .env.example .env.docker.local
```

Edit `.env.local` and/or `.env.docker.local` with your credentials, depending
on which mode(s) you'll run. In `.env.docker.local`, point `DATABASE_URL` and
`REDIS_URL` at the compose service names (`postgres`, `redis`) on their
container-internal ports, rather than `localhost`.

3. **Start services with Docker:**

```bash
docker compose up -d
```

4. **Generate and run database migrations:**

No migrations are committed yet — generate them from `lib/db/schema.ts` first,
then commit `lib/db/migrations/` so deploys can replay them.

```bash
npm run db:generate
npm run db:migrate
```

5. **Start the dev server:**

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

### Start the Python worker

```bash
cd workers/app
pip install "poetry>=2.5,<3"
poetry install   # installs exactly what poetry.lock pins
python worker.py
```

### Dependencies and lockfiles

`package-lock.json`, `workers/db-writer/package-lock.json` and `workers/app/poetry.lock` are committed, and the Dockerfiles install from them without re-resolving (`npm ci`, `poetry install`). To change a dependency, edit the manifest, run `npm install` (or `poetry lock` in `workers/app`), and commit the updated lockfile. `.github/dependabot.yml` opens weekly update PRs.

### Start the DB writer

```bash
npm run worker:db-writer
```

## Your First Job

The shipped example reads a web page and reports on it. It needs a model
provider and nothing else — no search API, no scraping service.

1. **Point it at a model.** In `.env.local` set `LLM_PROVIDER` and the matching
   key:

   ```bash
   LLM_PROVIDER=openai
   OPENAI_API_KEY=sk-...
   ```

   `anthropic` and `openrouter` work the same way. The default, `ollama`, needs
   no key but does need Ollama running locally at `OLLAMA_BASE_URL`.

2. **Sign in** and open `/dashboard`.

3. **Paste a URL** into "New report" — optionally add a question to focus it —
   and submit. You'll land on `/dashboard/jobs/<id>`, watch progress stream in
   over SSE, and get a summary, the key takeaways and the sources.

If the report can't be produced — no model key, an unreachable page, the agent
spending its tool-call budget — the job still completes and tells you which of
those happened, rather than failing silently.

### What the example does

| Step | What runs |
| --- | --- |
| Data Collection | `fetch_url` in `workers/app/tools/fetch_url.py` |
| AI Processing | the bounded agent in `workers/app/agents/research_agent.py` |
| Results Generation | assembles `summary`, `insights`, `sources` |

`fetch_url` treats the URL as hostile input, because it is: end users supply it
and the worker shares a network with Postgres and Redis. It allows http(s)
only, refuses hosts that resolve to loopback, private, link-local or otherwise
non-public addresses, re-checks every redirect hop, caps response size and
time, accepts only text-ish content types, and truncates the extracted text so
a large page can't blow up the prompt.

### Adding a tool

One new file. Create `workers/app/tools/my_tool.py` and expose a module-level
`TOOL`:

```python
from langchain_core.tools import StructuredTool

async def _summarize(text: str) -> str:
    """Summarize text. The model reads this docstring, so be specific."""
    ...

TOOL = StructuredTool.from_function(coroutine=_summarize, name="summarize")
```

There is no registry to update: `workers/app/tools/__init__.py` discovers it and
the agent gets it on the next job. A tool module that fails to import raises
loudly instead of leaving the agent quietly short a tool.

### Tracing what the agent did

The worker can ship each agent run to [LangSmith](https://docs.smith.langchain.com/)
so you can read the prompts, tool calls and completions behind a job. It is
**off unless you turn it on** — a trace contains your users' prompts and the
model's answers, so that is a decision, not a default.

```bash
# In .env.local (host) and .env.docker.local (containers)
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
```

Both are required: with the switch on and no key, tracing stays off and the
worker logs why at startup. `LANGSMITH_ENDPOINT` defaults to the hosted
collector (`https://api.smith.langchain.com`); set it to your own instance's
API URL (for example `http://langsmith.internal:8000/api`) to keep traces on
your infrastructure. `LANGSMITH_PROJECT` chooses the project runs land in;
`.env.example` prefills it with your project slug, and unset it falls back to
LangSmith's `default` project.

Runs are named `job:<job type>` and carry the job id, job type and user id as
metadata, so a trace maps back to the row in `jobs`.

Tracing never costs you a job. `workers/app/tracing.py` never raises, and once
tracing is on the traces are delivered in the background, so an unreachable
collector shows up as a log line while the job finishes normally.

### Running the worker tests

```bash
cd workers/app
poetry install
poetry run pytest
```

They use a scripted fake model and an injected fake fetcher, so they need no
API key and never touch the network.

## Dependency Notes

Two dependencies are deliberately held back:

- **TypeScript is held to the 6.x line (`^6`).** TypeScript 7 is a compiler rewrite that does
  not yet ship a stable programmatic compiler API, so typescript-eslint and
  Next's template/type checkers cannot run on it. Move to 7 once those tools
  support it (expected in the following minor).
- **ESLint is held to the 9.x line (`^9`).** `eslint-config-next` bundles `eslint-plugin-react`
  (and friends), which do not support ESLint 10 yet: `npm run lint` crashes with
  `getFilename is not a function`. Move to 10 once they do.

Drizzle ORM/Kit stay on the stable 0.x line; 1.0 is still a release candidate.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:push` | Push schema (dev only) |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:studio` | Open Drizzle Studio |
| `scripts/check_compliance.sh` | Prove the `/legal` pages' claims against a running app, in a real browser (see [the compliance guide](docs/compliance.md)) |

Operating a deployed instance — status, logs, an interactive shell, and
provisioning, deploying, editing secrets and taking a backup — is `opsctl`,
not an npm script or an `ansible-playbook` command remembered over SSH — see
[The CLI](#the-cli).

## Compliance

The app ships a `/legal` hub, linked from the footer, that explains how it
handles common legal risks, and the operator details those pages need (your
postal address, DMCA agent, accessibility contact) live in `config.ts`'s
`legal` section as placeholders to replace before launch. Every new account
passes a neutral age screen first (COPPA; the minimum age is
`legal.minimumAge`, 13 by default), and no date of birth is kept. Its key
pages are checked against WCAG 2.2 AA, and `/legal/accessibility` is its
accessibility statement.{% if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %} Marketing email goes only through `sendMarketingEmail`
(`lib/marketing-email.ts`), which refuses to send until `legal.marketingPostalAddress`
is set, skips anyone who has unsubscribed, and adds the unsubscribe link,
postal address and one-click unsubscribe headers (CAN-SPAM);
`/legal/email-preferences` explains which emails are marketing and how to
opt out.{% endif %}
{%- if cookiecutter.include_stripe == "yes" %} Every subscribe button shows the plan's
automatic-renewal terms beside it, Stripe Checkout repeats them and requires
agreeing to the Terms of Service, new subscribers are emailed the same terms
and how to cancel (when Resend is configured), and `/legal/subscriptions`
explains renewal, cancellation and refunds (California's Automatic Renewal
Law).
{%- endif %}
[docs/compliance.md](docs/compliance.md) covers each risk, what the app
already does and what is still up to you. It is not legal advice.

## Deployment

```bash
ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass
```

That is the whole thing: it builds the images locally, ships them, runs the
migrations and switches the stack over. The host comes from
`ansible/inventory.ini` — the same one provisioning uses — so there is no
address to fill in anywhere, and the production secrets come from
`ansible/vault.yml`, which is committed encrypted, so there is no
`.env-production` to copy by hand.

Before the first deploy, set the secrets up once:

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml                    # every value it lists
ansible-vault encrypt ansible/vault.yml      # asks for a vault password
git add ansible/vault.yml                    # committed, encrypted
```

`.gitignore` excludes the vault *password* file, never the vault. Change a
value later with `ansible-vault edit ansible/vault.yml`, which never writes
plaintext to disk — and the playbook refuses to run if the vault is not
encrypted, so forgetting that step is a refusal rather than a leak.

Deploying a subset, which the shell script this replaces did with positional
arguments:

```bash
ansible-playbook ... ansible/deploy.yml -e deploy_targets=app
ansible-playbook ... ansible/deploy.yml -e deploy_targets=worker,db-writer
ansible-playbook ... ansible/deploy.yml -e deploy_targets=none   # env file only
ansible-playbook ... ansible/deploy.yml --tags preflight         # check, deploy nothing
```

`migrator` joins any non-empty set: the migrator image already on the host is
the previous release's, so shipping new app code without it would run the
previous release's migrations. Everything else adjustable — the domain, the
platform images are built for, how long the health check waits — is in
`ansible/group_vars/all.yml`.

### What a deploy does, in order

The order is the guarantee that a failed deploy leaves the previous version
serving: everything that can fail happens before anything changes what serves.

1. **Pre-flight.** The vault is encrypted, and `{{ cookiecutter.domain_name }}`
   resolves to the host being deployed to. Nothing is built yet. That second
   check exists because Let's Encrypt rate-limits *failed* challenges and Caddy
   asks for a certificate as it starts, so deploying before DNS propagates can
   cost hours of issuance rather than one failed attempt. It aborts saying what
   resolved and what was expected; `-e dns_check=false` proceeds anyway, which
   is the answer when the record points at a CDN on purpose.
2. **Build**, on your machine, not the server — the server never needs the
   source, and a small VPS running the database should not also run
   `next build`.
3. **Ship** the compose file, the `Caddyfile`, a freshly rendered
   `.env-production` (mode `0600`, owned by `__DEPLOY_USER__`) and the new
   images, tagged with the release rather than only `:latest`. None of this
   touches the running containers.
4. **Migrate**, using this release's migrator image, with Postgres up and the
   app not yet switched. A migration that fails stops the deploy here.
5. **Switch**: move the `:latest` tags and bring the stack up. If the
   switched-over stack does not answer, the previous release's images *and* its
   compose file and `Caddyfile` are put back, the stack is restarted on them,
   and the deploy fails loudly. The configuration matters as much as the images:
   old images under a new compose file is not the release you were running.

The release name is a digest of the images in it, so re-running an unchanged
deploy ships nothing and changes nothing. `/app/{{ cookiecutter.project_slug }}/RELEASE`
on the host records which release is serving.

Four honest limits:

- **`ansible-vault` decrypts on *your* machine**, and the rendered env file
  lands on the host. So nothing is at rest in plaintext anywhere except that one
  `0600` file — but the machine running the deploy does see the values.
- **The switch is `docker compose up -d`**, which stops a container before
  starting its replacement. A broken release costs the seconds until the
  rollback, not zero.
- **The rollback covers a deploy that *fails*, not one that is interrupted.** It
  runs when a task fails. Ctrl-C, a dropped SSH connection or a killed
  `ansible-playbook` between the tag move and the health check leaves the new
  release serving and nothing rolled back. Re-running the previous release's
  deploy is the way back from that.
- **`.env-production` does not roll back.** It is rendered from the vault and
  `group_vars` — your current values, not the release's content — so a value you
  changed deliberately stays changed. Only release content rolls back.

### Provisioning the host

`ansible/provision.yml` takes a fresh VPS to the state the stack needs. Put the
server's address in `ansible/inventory.ini` and run it:

```bash
pipx install ansible          # or pip install ansible
ansible-playbook -i ansible/inventory.ini ansible/provision.yml
```

Running it again changes nothing, so re-run it rather than applying edits to
`ansible/group_vars/all.yml` by hand. The host has to be Debian-family (Ubuntu
LTS) and answer as root over SSH with your key the first time; a stock cloud
image does.

What it leaves behind:

- **`__DEPLOY_USER__`**, the account `ansible/deploy.yml` logs in as — key-only,
  passwordless sudo, in the `docker` group, with
  `/app/{{ cookiecutter.project_slug }}` to deploy into.
- **SSH with no way in but a key.** Root login and password authentication are
  both off, and the playbook asserts that against `sshd -T` rather than trusting
  the file it just wrote.
- **A firewall** (`ufw`) denying inbound traffic except SSH, 80, and 443 on both
  TCP and UDP — the UDP rule is HTTP/3, which Caddy advertises.
- **`fail2ban`** banning repeated SSH authentication failures, reading the
  journal rather than the `/var/log/auth.log` this release no longer writes.
- **Unattended security upgrades**, restricted to security origins, with no
  automatic reboot — kernel updates wait for a reboot you choose.
- **Log rotation** that covers the three places logs pile up: `logrotate`, a
  capped journal, and a cap on Docker's own container logs.
- **Docker Engine and the compose plugin**, from Docker's apt repository rather
  than the distribution's `docker.io`, which ships no `docker compose`.

The first run connects as root; after it, root cannot log in, so later runs
connect as the deploy user. The playbook works out which of the two answers
before it connects, so the command never changes. Within the run, the deploy
user is created, given your key, and watched logging in *before* root's access
is removed — a wrong key fails while you can still get in.

No reverse proxy is installed: Caddy runs in the stack (see [HTTPS](#https)), so
provisioning's job is to leave 80 and 443 open and unoccupied. One caveat worth
knowing: Docker publishes ports through its own iptables chain, which `ufw` does
not filter. That is fine as long as the production stack publishes only 80 and
443 — publish another and it is exposed whatever `ufw` says.

### HTTPS

TLS needs no step of its own. The production stack runs its own Caddy, so once
the stack is up, HTTPS is up: Caddy obtains a certificate for
`{{ cookiecutter.domain_name }}` from Let's Encrypt on first boot, renews it, and
redirects HTTP to HTTPS. Nothing else publishes a port — the app, PostgreSQL and
Redis are reachable only from inside the stack.

Bringing the stack up is `ansible/deploy.yml`: `docker-compose.prod.yml` has no
build context, so the images have to be built and shipped, and `.env-production`
has to exist next to the compose file or compose aborts — which is why the
playbook renders it there rather than expecting you to copy one.

**Point `{{ cookiecutter.domain_name }}`'s A/AAAA record at the host before the
first deploy.** Issuance is a challenge against that name, so it fails until DNS
resolves and ports 80 and 443 reach the container. Caddy retries with a backoff,
so fixing DNS later recovers on its own — but Let's Encrypt rate-limits
failures, so the record is cheaper to get right first.

Set `NEXTAUTH_URL=https://{{ cookiecutter.domain_name }}` in `.env-production`,
and register that origin's `/api/auth/callback/...` URLs with your OAuth
providers.

Certificates and the ACME account key live in the `caddydata` volume. Keep it
across deploys — losing it re-issues on the next boot, straight into a rate
limit.

Edit `Caddyfile` to change the proxy's behaviour: the domain was baked in at
generation time, not read from anywhere at runtime, so serving a different name
means editing that file.

If `Caddyfile` has no `email` in a global block, that is deliberate: the address
this project was generated with was at a reserved example domain, which a
certificate authority can reject. Certificates are still issued on an anonymous
account — but nobody is mailed when renewal starts failing, so add a real
address once you have one:

```caddyfile
{
	email you@your-real-domain.com
}
```

#### Smoke-testing before DNS exists

`SITE_ADDRESS` overrides the name Caddy serves. Point it at localhost and Caddy
issues from its own local CA instead of asking Let's Encrypt for a name that
does not resolve yet:

```bash
SITE_ADDRESS=https://localhost docker compose -f docker-compose.prod.yml up -d
curl -k https://localhost/
```

The redirect, TLS termination and the proxy hop are the production path; only
the issuer differs.

## The CLI

Operating a deployed instance otherwise means remembering `docker compose`
invocations over SSH. `opsctl` is that memory, and nothing more: it reads the
host out of `ansible/inventory.ini` and `ansible/group_vars/all.yml` — the
same files `provision.yml` and `deploy.yml` read — so there is exactly one
place the host is configured, and it authenticates by shelling out to your own
`ssh`, which means your `~/.ssh/config`, your agent and your `known_hosts`
decide how the connection is made. It manages no key of its own.

It ships as an npm `bin`, built from TypeScript by the `prepare` script that
runs on `npm ci`/`npm install`, so it needs no separate build step:

```bash
npm ci                # builds cli/dist as a side effect (the "prepare" script)
npm link              # optional: puts a bare `opsctl` on PATH
opsctl config         # or, with no npm link: npm run cli -- config
```

Running it with no arguments lists what it can do:

| Command | What it does |
|---------|--------------|
| `opsctl config` | First-run check: is a host configured, is `ansible/vault.yml` encrypted, does the host answer over SSH. Observes only — changes nothing |
| `opsctl status` | `docker compose ps` on the host |
| `opsctl logs <service>` | `docker compose logs`; every argument passes straight through, so `-f` follows and `--tail=100` limits, exactly as it would locally |
| `opsctl shell <service> [command]` | `docker compose exec -it`; defaults to `sh` when no command is given |

`opsctl config` is a smaller claim than a deploy preflight — it answers "can I
even start", not "will a deploy succeed" (no DNS check, no disk space, no
migrator image). Run it first on a fresh clone; a placeholder host or a
plaintext vault is refused by name rather than surfacing as a confusing
failure three commands later.

Those four are read-only. The rest change the host, and each wraps a playbook
or tool this README already documents rather than reimplementing it — there
is exactly one deployment code path whether a human types the
`ansible-playbook` command or `opsctl` does:

| Command | What it does |
|---------|--------------|
| `opsctl provision [-- ansible args]` | [Provisions](#deployment) the host (`ansible-playbook ansible/provision.yml`); everything after `--` passes through, e.g. `-e deploy_public_key_file=...` |
| `opsctl deploy [targets...] [--no-migrate]` | [Deploys](#deployment) (`ansible-playbook ansible/deploy.yml`); `opsctl deploy` ships everything, `opsctl deploy app worker` ships a subset, `--no-migrate` is `-e run_migrations=false` |
| `opsctl migrate` | Runs pending migrations and ships nothing else (`-e deploy_targets=migrator`) |
| `opsctl secrets edit` | `ansible-vault edit ansible/vault.yml`, interactively, in your own `$EDITOR` — never decrypted to disk |
| `opsctl backup` | Takes a backup right now: `systemctl start {{ cookiecutter.project_slug }}-db-backup.service` on the host, the schedule [already installed](#database-backups) |
| `opsctl preflight` | `opsctl config`'s checks, then `ansible-playbook ansible/deploy.yml --tags preflight` — catches unresolved DNS, an unreachable host and missing configuration before a deploy does |

`provision`, `deploy`, `migrate` and `preflight` all run on the control
machine, exactly like typing the `ansible-playbook` command by hand — only
`backup` connects over SSH, because it starts something the playbooks already
put on the host rather than running a playbook itself. Extra
`ansible-playbook` arguments to `deploy` or `migrate` go after a literal `--`
(`opsctl deploy app -- -e dns_check=false`), so a flag's own value can never be
mistaken for a deploy target.

There is no `restore` command, deliberately: `opsctl restore` says so and
points at [Database backups](#database-backups)'s restore steps, which stay a
manual procedure — see that section for why.

## Database backups

**Restore is not automated.** Nothing here puts a dump back — there is no script
and no playbook for it. What `ansible/backup.yml` installs is the half that has
to happen unattended: dumps on a schedule, copied somewhere this host is not,
pruned on a policy, and loud when they fail. Putting one back is four commands
you run deliberately, with the site down, having chosen which dump to use:

```bash
# 1. Fetch it. `rclone lsl backup:<bucket>/<prefix>` lists them, newest last;
#    the name is the UTC second the dump was taken.
sudo rclone --config /etc/{{ cookiecutter.project_slug }}-db-backup/rclone.conf \
  copyto backup:<bucket>/<prefix>/db-20250104T033012Z.dump /tmp/restore.dump

# 2. Stop everything that writes. Restoring into a live database gets you a
#    database that is neither the old one nor the new one.
cd /app/{{ cookiecutter.project_slug }} && docker compose -f docker-compose.prod.yml \
  --env-file .env-production stop app worker db-writer

# 3. Restore. --clean --if-exists drops what is there first, so this replaces
#    rather than merges.
docker exec -i {{ cookiecutter.project_slug }}-postgres-1 pg_restore \
  --clean --if-exists --no-owner -U postgres \
  -d {{ cookiecutter.project_slug | replace('-', '_') }} < /tmp/restore.dump

# 4. Bring it back, and check the data before you let traffic in.
docker compose -f docker-compose.prod.yml --env-file .env-production up -d
```

Those are steps in a README rather than a script because an untested restore
script is worse than none: it reads as a guarantee, and the day you discover it
does not work is the day you needed it. Run them against a throwaway database
once, before you need them.

### Setting them up

Run this after the stack is up — the dump comes out of the running Postgres
container, so a schedule installed against a stack that has never existed is a
schedule that fails.

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml            # where the dumps go, and where alerts go
ansible-vault encrypt ansible/vault.yml
ansible-playbook -i ansible/inventory.ini ansible/backup.yml
# then, on the host, take the first one now rather than waiting for 03:30:
sudo systemctl start {{ cookiecutter.project_slug }}-db-backup.service
```

Running it again changes nothing. Three values are required, and the playbook
refuses to install a schedule without them rather than installing one that
quietly does less than it looks like:

- **`vault_backup_remote`** and **`vault_backup_remote_path`** — where dumps go.
  A dump that only ever lands on the machine being backed up is not a backup, so
  "unconfigured" is a refusal, not a fall back to local-only.
- **`vault_backup_alert_url`** — where a failure goes. Without it the only record
  of a broken backup is a journal entry on the broken host.

### What gets installed

| Concern | What the playbook leaves |
|---------|--------------------------|
| The dump | `pg_dump --format=custom`, run **inside** the Postgres container — the one client that cannot be older than the server, and the database publishes no port for anything else to reach |
| Schedule | `{{ cookiecutter.project_slug }}-db-backup.timer`, 03:30 UTC daily with up to 45 minutes of jitter, `Persistent=true` so a missed run happens at the next boot |
| Off-host copy | `rclone` to whatever `vault_backup_remote` names — any S3-compatible bucket, or any other rclone backend, without the playbook changing |
| Verification | The archive has to parse (`pg_restore --list`) and read back from the destination at the same size, before anything is pruned |
| Retention | 7 dumps here, 30 at the destination |
| Failure | `OnFailure=` → a POST to `vault_backup_alert_url`, a journal entry at priority `err`, and `/var/lib/{{ cookiecutter.project_slug }}-backup/FAILED` |
| Staleness | `{{ cookiecutter.project_slug }}-db-backup-watch.timer`, six-hourly, failing when the last success is over 30 hours old |
| Dumps | `/var/backups/{{ cookiecutter.project_slug }}`, mode 0700 — a dump is the whole database, every token in it included |

Everything adjustable is in `ansible/group_vars/all.yml` — the schedule, the
retention numbers, the staleness limit, the alert payload's shape — or
overridable for one run with `-e`.

### Why nothing prunes the last good copy

Two rules, both asserted in CI against a real destination:

- **Nothing is pruned until the dump has been verified at the destination.** A
  run that fails deletes nothing. A half-working backup that still prunes is how
  a retention policy comes to eat the last good copy.
- **The newest dump is never pruned.** Dumps are named for the UTC second they
  were taken, so sorting names sorts by time and the prune only looks past the
  newest *N*. A retention policy of zero is refused outright.

### When they break

A failing timer writes to the journal and stops there, and the journal is a
complete record nobody reads unprompted — so a timer failing for a month looks
exactly like one that never failed. Hence three channels with different failure
modes: the **POST** to `vault_backup_alert_url` (the only one that reaches
somebody who was not already looking), a **journal entry** at `err`, and a
**marker file** the next success removes, so its presence means "broken now"
rather than "broke once".

And the case none of those catch — backups that simply stopped, where nothing
failed so nothing reported. The `-watch` timer fails when the last success is
over 30 hours old and routes to the same alert. While backups are stale you hear
about it four times a day, deliberately: a nag is how an alert survives a busy
week.

```bash
cat /var/lib/{{ cookiecutter.project_slug }}-backup/last-success   # when, which dump, how big
systemctl list-timers '{{ cookiecutter.project_slug }}-db-backup*' # when next, when last
journalctl -u {{ cookiecutter.project_slug }}-db-backup.service -n 50
```

Set `vault_backup_heartbeat_url` too if you want the one thing an on-host check
cannot give you: it is pinged after every success, for a service
(healthchecks.io, Cronitor, an Uptime Kuma push monitor) that alerts when the
pings stop. The staleness timer catches a schedule that stopped firing; it
cannot report a host that is powered off, out of disk or destroyed, because by
then nothing on it runs.

### What backups do not cover

- **Restore, as above.** Practise it before you need it.
- **Anything but Postgres.** Redis holds the job queue and the `caddydata`
  volume holds certificates. Losing the queue costs in-flight jobs; losing the
  certificates costs a re-issue, which Let's Encrypt rate-limits.
- **Encryption beyond the destination's own.** The dump is uploaded as `pg_dump`
  wrote it, so what protects it is the bucket's access control. If you need the
  destination unable to read it, add an `rclone` crypt remote — and keep that key
  somewhere other than the host it encrypts.
- **A credential that cannot delete.** Pruning needs delete, so the credential on
  this host has it, and a compromised host can empty the bucket. Scope it to the
  one bucket and turn on object lock or versioning if your provider offers them.

## Project Structure

```
app/                    # Next.js App Router pages
  (main)/               # Main route group
    (auth)/             # Auth pages (sign-in, sign-up)
    dashboard/          # Authenticated area
    legal/              # /legal hub and one page per compliance topic
  actions/              # Server actions
  api/                  # API routes
components/             # React components
config.ts               # Central app config
lib/
  auth.ts               # NextAuth config
  db/schema.ts          # Drizzle schema
  db/index.ts           # DB connection
  queue/                # BullMQ queue helpers
  redis.ts              # ioredis singleton
  stripe.ts             # Stripe helpers
workers/
  app/                  # Python worker
    tracing.py          # Opt-in LangSmith tracing (off by default)
  db-writer/            # Node.js DB writer
scripts/
  migrate.sh            # Migration runner (the migrator image's command)
  check_compliance.sh   # Runs tests/compliance against a real, running app
cli/
  src/                  # opsctl — status, logs and shell over your own SSH
  tsconfig.json         # Built by `npm run cli:build` / the `prepare` script
ansible/
  provision.yml         # Takes a fresh VPS to a ready state
  deploy.yml            # Builds, ships, migrates and switches over
  backup.yml            # Installs scheduled, off-host database backups
  inventory.ini         # The host all three playbooks act on
  group_vars/all.yml    # Deploy account, ports, log caps, deploy and backup settings
  vault.yml.example     # Every production secret, to fill in and encrypt
  templates/            # .env-production and the backup units, rendered on the host
Caddyfile               # TLS and HTTP->HTTPS for {{ cookiecutter.domain_name }}
```

## License

Private
