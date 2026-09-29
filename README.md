# cookiecutter-ai-saas

A cookiecutter template for scaffolding production-ready, full-stack AI SaaS
applications: Next.js + a Python AI worker, with auth, billing, background
jobs, and one-command VPS provisioning and deployment.

> **Status: pre-release.** This template is being modernized ahead of its first
> tagged release — dependencies, the agent layer, and deployment tooling are all
> in flight. Not yet recommended for production use.

## Quick Start

### Via Cookiecutter CLI

```bash
pip install cookiecutter
cookiecutter gh:CrimsonCowLabs/cookiecutter-ai-saas
```

### Non-Interactive

```bash
cookiecutter gh:CrimsonCowLabs/cookiecutter-ai-saas \
  --no-input \
  project_name="Invoice AI" \
  database_extensions=pgvector \
  llm_provider=anthropic
```

---

## What You Get

Every generated project is a complete distributed system with **115 files**:

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│                   (SSE real-time updates)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Next.js 16 App                            │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ App Router│  │Server Actions│  │  API Routes (SSE,     │ │
│  │ + Pages   │  │(auth→rate    │  │  webhooks, auth)      │ │
│  │ + Layouts │  │ limit→mutate │  │                       │ │
│  │ + Comps   │  │ →audit)      │  │                       │ │
│  └──────────┘  └──────┬───────┘  └───────────────────────┘ │
└─────────────────────────┼───────────────────────────────────┘
                          │ BullMQ dispatch
┌─────────────────────────▼───────────────────────────────────┐
│                       Redis                                  │
│         ┌─────────────────────────────────┐                  │
│         │  BullMQ Queues + Pub/Sub        │                  │
│         │  job:{id}:progress              │                  │
│         │  job:{id}:result                │                  │
│         └─────────┬───────────┬───────────┘                  │
└───────────────────┼───────────┼──────────────────────────────┘
                    │           │
  ┌─────────────────▼───┐  ┌───▼─────────────────┐
  │   Python Worker     │  │   Node.js DB Writer  │
  │   (BullMQ consumer) │  │   (Redis subscriber) │
  │                     │  │                      │
  │   3-step pipeline:  │  │   Persists results   │
  │   1. Data Collect   │  │   to database        │
  │   2. AI Processing  │  │                      │
  │   3. Results Gen    │  │                      │
  └─────────────────────┘  └──────────┬───────────┘
                                      │
                    ┌─────────────────▼─────────────────┐
                    │          Database                  │
                    │           PostgreSQL               │
                    │  (optional: pgvector)              │
                    └───────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16, React 19, TypeScript (strict) |
| **Styling** | Tailwind CSS 4, DaisyUI 5 |
| **Auth** | NextAuth v5 (Google, Microsoft, Magic Link; each optional) |
| **Database** | Drizzle ORM (PostgreSQL) |
| **Queue** | BullMQ (Redis-backed job queue) |
| **Workers** | Python 3.14 (async BullMQ consumer) |
| **DB Writer** | Node.js (Redis subscriber → database) |
| **Payments** | Stripe (subscriptions + one-time) |
| **Email** | Resend (magic link, transactional) |
| **LLM** | Ollama, OpenAI, Anthropic, or OpenRouter |
| **Deployment** | Docker (multi-stage), Caddy |

---

## Template Variables

| Variable | Default | Options | Description |
|----------|---------|---------|-------------|
| `project_name` | My AI App | any string | Display name for the app |
| `project_slug` | my-ai-app | auto-generated | URL/directory-safe name |
| `project_description` | A full-stack AI-powered SaaS application | any string | Used in meta tags and README |
| `author_name` | Your Name | any string | Package author |
| `author_email` | you@example.com | any string | Package author email, and the ACME account address in the `Caddyfile` — a placeholder here means no `email` directive (see [HTTPS](#https)) |
| `domain_name` | myapp.example.com | any string | Production domain. The `Caddyfile` serves and obtains a certificate for exactly this name |
| `primary_color` | #c2410c | any hex color | Brand color (DaisyUI primary) |
| `daisyui_theme` | dark | any DaisyUI theme | Base UI theme |
| `database_extensions` | none | none, pgvector | PostgreSQL extensions |
| `include_stripe` | yes | yes, no | Stripe billing integration |
| `include_marketing_extras` | yes | yes, no | Static JSON blog and contact form (with its API route) |
| `auth_providers` | google_microsoft | google_microsoft, google_only, microsoft_only | OAuth providers |
| `include_magic_link` | yes | yes, no | Email magic-link sign-in via Resend, independent of the OAuth choice. `no` drops its form, `/magic-link` page and provider; `RESEND_API_KEY` stays only if the contact form is kept |
| `llm_provider` | ollama | ollama, openai, anthropic, openrouter | AI model provider |
| `python_version` | 3.14 | any version | Python for worker Dockerfile. `poetry.lock` is resolved for 3.14; any other value drops it and you must run `poetry lock` in `workers/app` once |
| `node_version` | 20 | any version | Node.js for Dockerfiles |
| `redis_port` | 6379 | any port | Local Redis port mapping |
| `postgres_port` | 5432 | any port | Local PostgreSQL port mapping |

---

## Generated Project Structure

```
<project-slug>/
├── app/                           # Next.js App Router
│   ├── (main)/
│   │   ├── (auth)/                # Auth pages
│   │   │   ├── sign-in/           #   Email + OAuth sign-in
│   │   │   ├── sign-up/           #   Registration
│   │   │   └── magic-link/        #   "Check your email" page
│   │   ├── dashboard/             # Authenticated area
│   │   │   ├── page.tsx           #   Overview with stats + recent jobs
│   │   │   ├── settings/          #   Account + billing
│   │   │   ├── admin/             #   Admin tools (user management)
│   │   │   └── layout.tsx         #   Sidebar + auth guard
│   │   ├── blog/                  # Static JSON blog (optional)
│   │   ├── contact/               # Contact form (optional)
│   │   ├── privacy-policy/
│   │   ├── tos/
│   │   └── page.tsx               # Marketing landing page
│   ├── actions/                   # Server actions
│   │   ├── jobs.ts                #   submitJob, cancelJob, getJobStatus
│   │   └── billing.ts            #   createCheckout, createPortal
│   └── api/
│       ├── auth/[...nextauth]/    # NextAuth endpoints
│       ├── jobs/[id]/progress/    # SSE real-time progress
│       ├── webhook/stripe/        # Stripe webhooks
│       └── contact/               # Contact form API
│
├── components/
│   ├── auth/                      # OAuth buttons, magic link form
│   ├── dashboard/                 # Sidebar, stats cards, data table, job status
│   ├── blog/                      # Blog card, rich text renderer
│   ├── brand/                     # Logo SVG
│   └── ui/                        # Navbar, footer
│
├── lib/
│   ├── auth.ts                    # NextAuth config + DrizzleAdapter
│   ├── auth.config.ts             # Edge-safe OAuth config
│   ├── db/
│   │   ├── schema.ts              # 9 tables + enums + relations
│   │   └── index.ts               # Drizzle connection pool
│   ├── queue/jobs.ts              # BullMQ dispatch + cancel
│   ├── redis.ts                   # ioredis singleton
│   ├── stripe.ts                  # Checkout + portal helpers
│   ├── rate-limit.ts              # Redis sliding-window limiter
│   ├── audit.ts                   # Silent audit logging
│   ├── feature-flags.ts           # ENV-backed toggles
│   ├── validations.ts             # Zod schemas
│   ├── plans.ts                   # Plan tier config
│   ├── seo.tsx                    # SEO + JSON-LD helpers
│   └── api.ts                     # Client fetch wrapper
│
├── workers/
│   ├── app/                       # Python worker
│   │   ├── worker.py              #   BullMQ consumer (async)
│   │   ├── runner.py              #   3-step pipeline; step 2 runs the research agent
│   │   ├── settings.py            #   Config from env vars
│   │   ├── llm_utils.py           #   LLM provider abstraction
│   │   ├── tracing.py             #   Opt-in LangSmith tracing (off by default)
│   │   ├── agents/                #   Standalone agents (research_agent.py)
│   │   ├── tools/                 #   Agent tools, auto-discovered (fetch_url.py)
│   │   ├── tests/                 #   Pytest suite
│   │   ├── pyproject.toml         #   Poetry dependencies
│   │   └── poetry.lock            #   Locked Python dependency tree
│   └── db-writer/                 # Node.js result persister
│       ├── worker.mjs             #   Redis subscriber → DB
│       ├── package.json
│       └── package-lock.json
│
├── Dockerfile                     # Multi-stage (builder, runner, ops, migrator)
├── docker-compose.yml             # Dev: app + worker + db-writer + postgres + redis
├── docker-compose.prod.yml        # Prod: adds Caddy; nothing else on the host's ports
├── Caddyfile                      # TLS + HTTP→HTTPS for your domain
├── config.ts                      # Central app config (plans, resend, colors, auth)
├── middleware.ts                   # Edge-safe route protection
├── postcss.config.js              # Tailwind 4 PostCSS plugin (theme lives in app/globals.css)
├── drizzle.config.ts              # Migration generator config
├── package.json                   # Node dependencies
├── package-lock.json              # Locked Node dependency tree (Dockerfiles use npm ci)
├── .github/dependabot.yml         # Weekly dependency update PRs
├── tsconfig.json                  # Strict TypeScript
├── .env.example                   # All env vars documented
├── scripts/
│   └── migrate.sh                 # Database migrations (the migrator image's command)
├── ansible/
│   ├── provision.yml              # Takes a fresh VPS to a ready state
│   ├── deploy.yml                 # Builds, ships, migrates and switches over
│   ├── inventory.ini              # The host both playbooks act on
│   ├── group_vars/all.yml         # Deploy account, open ports, log caps, deploy settings
│   ├── vault.yml.example          # Every production secret, to fill in and encrypt
│   ├── templates/env-production.j2 # Rendered to .env-production on the host
│   └── requirements.yml           # Collections, for bare ansible-core
└── content/blog/                  # Sample blog posts (JSON)
```

---

## Database Schema

9 tables generated by default:

| Table | Purpose |
|-------|---------|
| `users` | User accounts (id, email, plan, isAdmin, stripeCustomerId) |
| `accounts` | OAuth provider accounts (NextAuth) |
| `sessions` | Active sessions (NextAuth) |
| `verification_tokens` | Email verification tokens (NextAuth) |
| `jobs` | AI processing jobs (status, type, input/output JSONB, progress) |
| `job_events` | Job progress events for SSE streaming |
| `subscriptions` | Stripe subscription records |
| `audit_logs` | User action audit trail |
| `contact_submissions` | Contact form submissions |

### Database Extensions

PostgreSQL is the only database. You can optionally enable:

- **pgvector** — Adds vector similarity search for embeddings. Docker image: `pgvector/pgvector:pg18`

---

## Post-Generation Setup

```bash
# 1. Enter your project
cd <project-slug>

# 2. Configure environment. Two files, because the host and the containers
#    reach Postgres and Redis at different hostnames.
cp .env.example .env.local        # npm run dev / db:migrate — services on localhost
cp .env.example .env.docker.local # docker compose — services on compose service names
# In .env.docker.local, point DATABASE_URL at @postgres:5432 and REDIS_URL at redis://redis:6379
# Then edit both — see "Environment Variables" below

# 3. Install dependencies
npm ci

# 4. Start infrastructure
docker compose up -d

# 5. Generate and run database migrations.
#    The template ships no migrations, so generate them from the schema first.
npm run db:generate
npm run db:migrate

# 6. Start the dev server
npm run dev
# → http://localhost:3000

# 7. Start the Python worker (separate terminal)
cd workers/app
pip install "poetry>=2.5,<3" && poetry install
python worker.py

# 8. Start the DB writer (separate terminal)
npm run worker:db-writer
```

---

## Environment Variables

After generation, configure these in `.env.local`:

### Required

| Variable | How to Get |
|----------|-----------|
| `NEXTAUTH_SECRET` | Run: `openssl rand -hex 32` |
| `DATABASE_URL` | Auto-set by docker-compose: `postgresql://postgres:postgres@localhost:5432/<slug>` |
| `REDIS_URL` | Auto-set by docker-compose: `redis://localhost:6379` |

### Auth Providers

| Variable | Source |
|----------|--------|
| `GOOGLE_ID` | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials |
| `GOOGLE_SECRET` | Same as above |
| `MICROSOFT_ENTRA_ID_ID` | [Azure Portal](https://portal.azure.com) → App Registrations |
| `MICROSOFT_ENTRA_ID_SECRET` | Same as above |
| `MICROSOFT_ENTRA_ID_TENANT_ID` | Leave blank for multi-tenant, or set specific tenant |
| `RESEND_API_KEY` | [resend.com](https://resend.com) → API Keys |

### Payments (if Stripe enabled)

| Variable | Source |
|----------|--------|
| `STRIPE_PUBLIC_KEY` | [Stripe Dashboard](https://dashboard.stripe.com/apikeys) |
| `STRIPE_SECRET_KEY` | Same as above |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → Signing secret |

### LLM Provider

| Provider | Variables |
|----------|-----------|
| Ollama | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL` (optional) |

Also optional: `RESEARCH_MAX_TOOL_CALLS` (default `8`) caps the tool calls the
AI step's agent may make in one job.

### Tracing (optional, off by default)

The worker can trace its agent runs to [LangSmith](https://docs.smith.langchain.com/).
It is opt-in, and stays off unless both switches below are set, because a trace
carries your users' prompts and the model's completions.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LANGSMITH_TRACING` | `false` | The on switch. Tracing needs this **and** an API key. |
| `LANGSMITH_API_KEY` | — | Collector credential. Empty means tracing stays off. |
| `LANGSMITH_ENDPOINT` | `https://api.smith.langchain.com` | Hosted collector by default; point it at a self-hosted LangSmith (`http://langsmith.internal:8000/api`) to keep traces on your own infrastructure. |
| `LANGSMITH_PROJECT` | `default` | Which LangSmith project runs land in. `.env.example` prefills it with your project slug. |

`workers/app/tracing.py` owns every one of these variables: it writes them from
settings at startup, clears any on switch it did not set — `LANGCHAIN_TRACING_V2`
and the retired v1 pair `LANGCHAIN_TRACING` / `LANGCHAIN_HANDLER` — and drops
LangSmith's memoised view of the environment so the result takes effect. A
variable inherited from the shell therefore cannot switch tracing on behind the
worker's back. Clearing the v1 pair matters twice over: LangChain raises on
*every* model call when it finds one of them set, so a forgotten export would
turn each job into a report-less one.

It fails open, in both directions. A missing key or an unwritable environment
leaves tracing off and logs why; the worker still starts. Once tracing is on,
delivery happens on LangSmith's background thread and LangChain swallows
callback failures, so an unreachable collector costs a log line, never a job.

Each traced run is named `job:<job type>`, tagged `job_type:<job type>`, and
carries `job_id`, `job_type` and `user_id` as metadata (`anonymous` when a job
has no user), so a trace can be matched back to the job row that produced it.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint check (flat config in `eslint.config.mjs`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Generate new Drizzle migration |
| `npm run db:push` | Push schema directly (dev only) |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |
| `npm run worker:db-writer` | Start the Node.js DB writer |

Provisioning and deploying are playbooks, not scripts — see
[Provisioning the host](#provisioning-the-host) and [Deploying](#deploying):

| Command | Description |
|---------|-------------|
| `ansible-playbook -i ansible/inventory.ini ansible/provision.yml` | Take a fresh VPS to a ready state |
| `ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass` | Build, ship, migrate and switch |
| `... ansible/deploy.yml -e deploy_targets=app` | Deploy one image |
| `... ansible/deploy.yml --tags preflight` | Check the vault and DNS, deploy nothing |

---

## Docker Services

### Development (`docker-compose.yml`)

| Service | Image | Ports |
|---------|-------|-------|
| `app` | Built from `Dockerfile` | 3000 |
| `worker` | Built from `workers/Dockerfile.worker` | — |
| `db-writer` | Built from `workers/db-writer/Dockerfile.writer` | — |
| `postgres` | `postgres:18-alpine` (`pgvector/pgvector:pg18` with pgvector) | 5432 |
| `redis` | `redis:7-alpine` | 6379 |

Scale workers: `docker compose up -d --scale worker=3`

### Production (`docker-compose.prod.yml`)

Same services with:
- Pre-built images (no build context)
- A `caddy` service that terminates TLS (see [HTTPS](#https))
- Only Caddy on the host's ports: the app, database and Redis are reachable
  only from inside the stack
- `.env-production` read by compose and injected as environment variables —
  the file itself is never mounted into a container, because it is `0600` and
  owned by the deploy account (see [Deploying](#deploying))

---

## Provisioning the host

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
| Firewall | `ufw`: inbound denied by default; SSH, `80/tcp`, `443/tcp` and `443/udp` (HTTP/3) open |
| Intrusion banning | `fail2ban`'s sshd jail, reading the journal |
| Security updates | `unattended-upgrades`, restricted to security origins, no automatic reboot |
| Log rotation | `logrotate.timer`, the journal capped at 500M, Docker's json-file logs capped |
| Container runtime | Docker Engine and the compose plugin, from Docker's apt repository |
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
  [HTTPS](#https)), so provisioning's part is to leave 80 and 443 open and
  unoccupied. The playbook fails if a host nginx or Apache is running on them,
  rather than letting Caddy fail to bind on the first deploy.
- **ufw does not see Docker's published ports.** Docker writes its own iptables
  chain. That is survivable here only because the production stack publishes 80
  and 443 and nothing else — add a published port to that stack and it is
  exposed whatever ufw says.
- **No application.** Provisioning ends at a ready host; `ansible/deploy.yml`
  takes it from there.

---

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

There is no address to fill in and no `.env-production` to copy: the address is
in the inventory and the env file is rendered on the host from the vault. Both
of those were how the shell script this replaces leaked secrets into shell
history.

| Instead of | Now |
|------------|-----|
| `./scripts/deploy.sh full` | `ansible-playbook -i ansible/inventory.ini ansible/deploy.yml` |
| `./scripts/deploy.sh app` | `... -e deploy_targets=app` |
| `./scripts/deploy.sh worker db-writer` | `... -e deploy_targets=worker,db-writer` |
| `./scripts/deploy.sh env` | `... -e deploy_targets=none` |
| — | `... --tags preflight` — check the vault and DNS, deploy nothing |

`migrator` is added to any non-empty `deploy_targets`, because the migrator
image already on the host belongs to the *previous* release: shipping new app
code and running the previous release's migrations against it is the failure
the ordering below exists to prevent. `-e run_migrations=false` skips running
them; nothing skips shipping the right image.

### Secrets

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
rendered `.env-production` lands on the host at mode `0600` owned by the deploy
account. Nothing is at rest in plaintext anywhere else — not in the repository,
not in a shell history, not in a file on your laptop. The machine running the
deploy still holds the password and sees the values while it runs; it has to.

Non-secret settings — the domain, the origin NextAuth builds callbacks from,
feature flags — are in `ansible/group_vars/all.yml` and in
`ansible/templates/env-production.j2`, in the clear, where they can be read in
a diff.

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
   but the app not switched. A failing migration stops the deploy here.
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
and answers on the stack's own network, not that TLS works: a certificate
arrives from an asynchronous ACME exchange that has not necessarily finished on
a first deploy, which is what the DNS pre-flight protects instead.

| Concern | Where it lives |
|---------|----------------|
| Secrets | `ansible/vault.yml`, encrypted; `ansible/vault.yml.example` documents every name |
| Non-secret settings | `ansible/group_vars/all.yml` |
| The production env file | `ansible/templates/env-production.j2`, rendered to `/app/<slug>/.env-production` on the host, `0600` |
| What is deployed | `/app/<slug>/RELEASE` on the host |
| Previous releases | still on the host, tagged `<slug>-<image>:<release>` |

`scripts/check_deploy.sh` is CI's end-to-end run of all of this against a
throwaway host, including deploying a deliberately broken release on top of a
working one and asserting the working one still answers.

---

## HTTPS

TLS needs no step of its own. The stack runs its own Caddy, generated from the
`domain_name` you answered, which obtains a certificate from Let's Encrypt on
first boot, renews it, and redirects HTTP to HTTPS — so once the stack is up,
HTTPS is up. There is no external proxy to stand up and no network to create by
hand.

Bringing the stack up still means what it did before: `docker-compose.prod.yml`
has no build context, so `ansible/deploy.yml` builds the images and ships them,
and `.env-production` has to exist next to the compose file or compose aborts —
which is why the playbook renders it there. Nothing about the proxy changes that.

Two prerequisites for the certificate, and neither is optional:

- **Point the domain's A/AAAA record at the host before the first deploy.**
  Issuance is a challenge against that name, so it fails until DNS resolves and
  ports 80 and 443 reach the container. Caddy retries with a backoff, so fixing
  DNS afterwards recovers without intervention — but Let's Encrypt rate-limits
  failures, so the record is cheaper to get in first.
- **Set `NEXTAUTH_URL=https://<your domain>` in `.env-production`**, and register
  that origin's OAuth callback URLs with your providers. Caddy sets
  `X-Forwarded-Proto`, which is what lets NextAuth (`trustHost: true`) build
  `https://` callbacks — but the configured origin still has to match.

| Concern | Where it lives |
|---------|----------------|
| Proxy config | `Caddyfile`, rendered from `domain_name` at generation time |
| Certificates | the `caddydata` volume — keep it across deploys, or every boot re-issues into a rate limit |
| Expiry warnings | mailed to `author_email`, unless that is at a reserved example domain (see below) |
| Published ports | `80`, `443`, `443/udp` (HTTP/3), on the `caddy` service only |

The app sits with Caddy on a `caddy-net` network that Postgres and Redis never
join, so the internet-facing container has no route to the database even if it is
compromised.

Responses are not compressed at the proxy. Next.js already compresses its own
output, and compressing a stream is how the SSE job-progress endpoint stops
arriving live.

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
ACME exchange. CI's `tls-stack` job runs exactly this, via
`scripts/check_tls_stack.sh`.

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

---

## Claude Code Integration

This template includes a Claude Code skill for project scaffolding:

### Slash Command

```
/new-project [project-name]
```

Interactive wizard that asks about database, auth, features, and LLM provider, then generates the project.

### Auto-Invoked Skill

Claude automatically recognizes requests like:
- "Create a new project"
- "Scaffold me an app"
- "Use the starter template"
- "Bootstrap a SaaS app"

### Autonomous Agent

The `project-scaffolder` agent can be spawned by Claude for complex scaffolding tasks within team workflows.

### Skill Files

```
.claude/
├── commands/new-project.md              # /new-project slash command
├── skills/new-project/SKILL.md          # Auto-invoked skill
└── agents/project-scaffolder.md         # Autonomous scaffolder agent
```

---

## Customization Guide

### The Shipped Example: a URL Report

A fresh clone does something real on the very first job, and needs no key
beyond a model provider. Submit a URL on the dashboard and the pipeline fetches
that page, reads it with a tool-calling agent, and returns a report:

```
input:  {"url": "https://example.com/article", "question": "optional focus question"}
output: {"status": "generated", "url", "title", "summary",
         "insights": [...], "sources": [...], "ai_enhanced": bool}
```

`url` is required; `question` is optional.

- **Step 1 "Data Collection"** calls `fetch_url` (`workers/app/tools/fetch_url.py`).
- **Step 2 "AI Processing"** hands the fetched page, plus every discovered tool,
  to the bounded agent in `workers/app/agents/research_agent.py`.
- **Step 3 "Results Generation"** assembles the report above.

The UI is `components/dashboard/new-job-form.tsx` to submit and
`/dashboard/jobs/[id]` for live progress and then the report.

`fetch_url` deliberately needs no API key — that is what keeps a first run free
of third-party signup. Because the URL comes from an end user and the worker
shares a Docker network with Postgres and Redis, the tool treats every request
as hostile: http/https only, and any host resolving to a loopback, private,
link-local, reserved or otherwise non-public address is refused — re-checked on
**every redirect hop**, since validating only the first URL is the usual SSRF
bypass. It caps the response size while reading rather than after, enforces a
timeout, accepts only text-ish content types, and truncates extracted text to a
character budget so a large page cannot blow up the prompt. It does not defend
against DNS rebinding; the module documents that limit rather than implying
coverage it lacks.

When there is no report — no model configured, the page could not be read, the
agent spent its tool-call budget — the job still completes, `ai_enhanced` is
`false`, and `summary` is a plain sentence naming what to change instead of a
bare "Processing complete".

### Adding a Tool the Agent Can Call

**One new file.** `workers/app/tools/__init__.py` discovers tools, so there is
no registry list to edit:

1. Create `workers/app/tools/my_tool.py`.
2. Expose the callable as a module-level `TOOL`:

   ```python
   from langchain_core.tools import StructuredTool

   async def _summarize(text: str) -> str:
       """Summarize text. The model reads this docstring, so be specific."""
       ...

   TOOL = StructuredTool.from_function(coroutine=_summarize, name="summarize")
   ```

That is the entire change: the AI step passes whatever `discover_tools()`
returns. Modules are visited in sorted order so the tool list — and therefore
the prompt — stays reproducible. A module with no `TOOL` is a plain helper and
is skipped, as are private modules (`_draft.py`) and subpackages. A module that
fails to import, or whose `TOOL` is not a LangChain `BaseTool`, raises
`ToolRegistryError` naming the module: a broken tool is never skipped quietly,
because an agent silently running with fewer tools is the worse failure.
`workers/app/tests/test_tool_registry.py` proves the one-file property.

To use a ready-made tool, add its package (`poetry add langchain-tavily`) and
re-export its tool as `TOOL` from one such file.

### Adding a New Pipeline Step

1. Put the work in a tool under `workers/app/tools/`
2. Add a `_step_*` function and an entry in `PIPELINE_STEPS` in `workers/app/runner.py`
3. Return a structured `status` instead of raising, so a job always finishes cleanly

### The AI Step and the Research Agent

Step 2 of the pipeline (`_step_process_with_ai` in `workers/app/runner.py`) runs
`workers/app/agents/research_agent.py`, a LangGraph tool-calling agent built
with `langchain.agents.create_agent`. The agent can call tools in a loop — it
gets the whole discovered tool set, so a new tool file reaches it with no change
to `runner.py` — and finishes by submitting a `ResearchReport`, which the step
maps onto `analysis.summary` and `analysis.insights` (the report's findings).
The full report is also under `research`. The agent module is standalone and
takes everything from its caller; it knows nothing about Redis, BullMQ, or
`settings`. You can use it directly:

```python
from agents.research_agent import run_research_agent, ResearchAgentError

report = await run_research_agent(
    "solar power",
    model=llm_utils.get_llm(),   # any LangChain chat model that supports tool calling
    tools=[my_tool],             # any LangChain tools; may be empty
    max_tool_calls=8,            # explicit bound; the call that would exceed it never runs
)
```

Bounds and exit behaviour. A runaway loop cannot run up an unbounded bill:

- `RESEARCH_MAX_TOOL_CALLS` (default 8) is the tool-call limit, the real
  bound; the LangGraph `recursion_limit` is derived from it as a backstop.
- Whatever ends the agent, the job still completes, with the same progress
  (0, 30, 30, 70, 70, 100, 100) however many tool calls ran. The AI step
  returns `{"status": "error", "reason": ..., "error": ...}` and the results
  step reports `ai_enhanced: false`. `reason` is `tool_call_limit`,
  `recursion_limit` or `invalid_report` (a report that does not satisfy the
  schema; no partial report is used). A provider or tool failure gives
  `status: "error"` without a `reason`.
- With no model configured (for example a missing API key) the step returns
  `{"status": "skipped", "reason": "no_llm_configured"}`.
- Every one of those cases becomes a user-facing sentence in the report's
  `summary`, so a job that produced nothing still says why.
- The rate limiter holds one slot for the whole agent run, not one per model
  call, so a run with many tool calls makes more requests than `*_RPM` implies.
- Tests use a scripted fake model (`tests/fakes.py`) and an injected fake
  fetcher, so the whole suite runs with no provider key and no network.

`run_research_agent` also takes `run_config`, LangChain runnable config merged
into the invocation (`metadata`, `tags`, `run_name`, `callbacks`). The AI step
fills it with the job's identity so traces are findable; it cannot loosen the
bounds, because `recursion_limit` always comes from the argument. See
"Tracing" under Environment Variables.

### Adding a New Database Table

1. Add the table definition in `lib/db/schema.ts`
2. Add relations if needed
3. Run `npm run db:generate` to create migration
4. Run `npm run db:migrate` to apply

### Adding a New Dashboard Page

1. Create `app/(main)/dashboard/my-page/page.tsx`
2. Add a nav item in `components/dashboard/sidebar.tsx`
3. The auth guard in `dashboard/layout.tsx` automatically protects it

### Adding a New API Route

1. Create `app/api/my-route/route.ts`
2. Follow the pattern: `auth()` → validate → process → respond
3. Add rate limiting with `enforceRateLimit()` if needed

### Changing the Theme

Edit `app/globals.css` (Tailwind 4 and DaisyUI 5 configure themes in CSS):
- `--color-primary` in the `@plugin "daisyui/theme"` block
- The `themes:` list in `@plugin "daisyui"` (default, `light`, and `dark`)
- `colors.theme` in `config.ts` sets the active `data-theme`

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **BullMQ over direct processing** | Long-running AI jobs need retry, progress tracking, and horizontal scaling |
| **Separate DB writer** | Decouples write path from worker; worker only publishes to Redis |
| **SSE over WebSockets** | Simpler for unidirectional progress updates; no persistent connection management |
| **JWT sessions** | Edge-compatible, no DB lookup per request, 30-day expiry |
| **Server actions** | Co-located mutations with auth/validation, automatic revalidation |
| **Drizzle over Prisma** | Lighter, SQL-like API, better edge support, faster cold starts |
| **DaisyUI over custom CSS** | Rapid prototyping with consistent dark theme, easy to override |
| **`_copy_without_render`** | Prevents Jinja2/TypeScript `{{ }}` conflicts in cookiecutter |

---

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

# 3. Restore. --clean --if-exists drops what is there first, so this is a
#    replacement and not a merge.
docker exec -i <slug>-postgres-1 pg_restore \
  --clean --if-exists --no-owner -U postgres -d <slug_with_underscores> \
  < /tmp/restore.dump

# 4. Bring the stack back, and check the data before you let traffic in.
docker compose -f docker-compose.prod.yml --env-file .env-production up -d
```

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
that [provisioning](#provisioning-the-host) already configured, and no version
is pinned in this template to go stale. The trade is a release that lags
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

---

## CI flag matrix

CI generates, typechecks, lints and builds eight named flag combinations (the `flag-matrix` job in `.github/workflows/generate-and-build.yml`). `python scripts/check_ci_matrix.py` fails if any value of any choice in `cookiecutter.json` is missing from the matrix, so a new choice value needs a matrix entry.

Five further jobs cover the parts no flag varies — serving, provisioning, deploying and backing up:

| Job | What it proves |
|---|---|
| `proxy-config` | The `Caddyfile` names the `domain_name` that was answered, and carries an `author_email` as the ACME account only when mail could reach it. Each case also goes through `scripts/check_caddyfile.sh`: fully rendered, `caddy fmt`-clean, and accepted by `caddy validate` |
| `tls-stack` | Bringing up `docker-compose.prod.yml` serves the app over HTTPS with a certificate that verifies, redirects HTTP to it, and publishes no port but the proxy's. Runs `scripts/check_tls_stack.sh` |
| `provisioning` | The playbook lints clean, then takes a throwaway host from stock image to ready state and leaves it that way: root refused over SSH, the deploy user logging in with a key, only the expected ports open, upgrades and rotation active — and a second run that changes nothing. Runs `scripts/check_provisioning.sh` |
| `deploy` | The deploy playbook lints clean, the template ships a vault example and no vault, and every name in that example is prefixed `vault_`. Then a throwaway host is deployed to for real: secrets reaching it only as a `0600` file rendered from the encrypted vault and printed nowhere, even under `--diff`; the DNS pre-flight aborting when the served name resolves somewhere other than the target; migrations applied before the new containers serve; a deliberately broken release leaving the previous one still answering — and a second run that changes nothing. Runs `scripts/check_deploy.sh` |
| `backups` | The backup playbook lints clean, refuses an unencrypted vault and a retention policy of zero, then installs itself on a provisioned throwaway host and is held to every criterion as behaviour: a dump taken from a live Postgres that still contains its rows, that same dump byte-for-byte at a separate destination, the timer firing on its own, pruning that deletes the oldest and never the newest, a broken destination surfacing as an alert delivered off the host while deleting nothing — and a second run that changes nothing. Runs `scripts/check_backups.sh` |

---

## License

MIT — see [LICENSE](LICENSE).
