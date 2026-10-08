# cookiecutter-ai-saas

A cookiecutter template for scaffolding production-ready, full-stack AI SaaS
applications: Next.js + a Python AI worker, with auth, billing, background
jobs, and one-command VPS provisioning and deployment.

**Project page:** <https://crimsoncowlabs.github.io/cookiecutter-ai-saas/>

> **Status: pre-release.** This template is being modernized ahead of its first
> tagged release — dependencies, the agent layer, and deployment tooling are all
> in flight. Not yet recommended for production use.

This README covers generating a project, running it locally, and the shape of
what you get. Three focused guides cover everything past that:

| Guide | Covers |
|-------|--------|
| [Deployment](docs/deployment.md) | Provisioning a VPS, deploying, secrets, TLS, database backups, operating a live instance |
| [The agent](docs/agent.md) | The shipped example agent, its loop and bounds, adding a tool |
| [Customization](docs/customization.md) | Adding a table, a dashboard page, an API route, a pipeline step, changing the theme |

## Quick Start

### Via Cookiecutter CLI

```bash
pipx install cookiecutter
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

Every generated project is a complete distributed system — **214 files** with
the default answers. The exact count depends on what you choose:
`include_stripe=no`, `include_marketing_extras=no` and the narrower
`auth_providers` choices each remove files that `hooks/post_gen_project.py`
deletes at generation time, and `analytics=posthog` keeps the consent and
analytics files the default `none` deletes, so don't expect the same number
from two different answer sets.

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

## Compliance Coverage

Generated apps are built with common legal risks for small SaaS apps in mind,
and prove what they claim against a running app rather than asserting it:

- **A `/legal` hub**, linked from the footer, next to the Privacy Policy and
  Terms. Each topic page says what the risk is and how the app handles it.
- **An age gate on every new account (COPPA).** Sign-up starts with a
  neutral date-of-birth screen, and the Auth.js `signIn` callback refuses a
  new account from Google, Microsoft or magic link alike without a passed
  check. Anyone under the configured minimum age (13 by default) is turned
  away, no date of birth is stored anywhere, and the check proves it by
  signing up through every provider against the running app.
  `/legal/children` is the children's privacy notice.
- **Renewal terms where customers subscribe (California ARL).** With Stripe
  included, every subscribe and upgrade button has the plan's auto-renewal
  terms (price, interval, renews until cancelled, how to cancel online)
  beside it, built from the plan's own config and linked with
  `aria-describedby`. Stripe Checkout repeats the same text and requires
  the terms-of-service box, which the check proves against a stand-in Stripe
  API. With Resend configured, the Stripe webhook emails each new subscriber
  one acknowledgment repeating the terms and how to cancel (none for
  one-time purchases); without it, `docs/compliance.md` says to turn on
  Stripe's own confirmation emails instead. `/legal/subscriptions` covers
  renewal, cancellation and refunds. A project without Stripe has none of it
  and makes no subscription claims.
- **Marketing email that can always be unsubscribed from (CAN-SPAM).**
  `sendMarketingEmail` is the one way to send commercial email: it refuses
  to send until the postal address is set, skips anyone who has opted out,
  and adds the unsubscribe footer, the postal address and one-click
  `List-Unsubscribe` headers (RFC 8058). Unsubscribe links are signed, never
  expire and need no sign-in, and opt-outs are kept apart from accounts so
  they survive deletion and re-sign-up. The check proves it against a
  stand-in Resend API. `/legal/email-preferences` says which emails are
  marketing and how to opt out; transactional email is unchanged.
- **No third-party requests before consent.** Fonts are self-hosted through
  `next/font`, and `scripts/check_compliance.sh` loads the public, auth, legal
  and dashboard pages in a headless Chrome and fails, naming the host, if any
  of them contacts another server. A Google Fonts `<link>` is called out by
  name.
- **Analytics only with consent (optional).** With `analytics=posthog`, an
  app-owned banner offers "Accept" and "Reject" with equal weight, works by
  keyboard and never traps focus. One consent module decides what may run;
  the choice is kept in a first-party cookie with the consent-text version,
  so bumping the version asks everyone again, and a Global Privacy Control
  signal counts as "Reject". PostHog loads only after "Accept", through a
  first-party `/ingest` proxy with IP capture off, and "Privacy choices" in
  the footer or `/legal/analytics` withdraws consent, which shuts it down
  and clears its storage. The check proves no analytics request is made
  before consent, after "Reject" or under GPC, and that one is made after
  "Accept". With the default `none` there is no dependency, banner or
  provider code, and `/legal/analytics` says nothing is tracked.
- **WCAG 2.2 AA on the key pages.** The same check runs axe-core over the
  landing, auth, legal, dashboard and settings pages in both themes, and
  fails on any violation, a missing skip-to-content link or an invisible
  focus outline. `/legal/accessibility` is the accessibility statement.
- **Ready for the DMCA safe harbor.** `/legal/copyright` names the
  configured copyright agent and explains takedown notices, counter-notices
  and the repeat-infringer policy, the Terms of Service link to it, and the
  check proves the agent's details are shown. The operator guide walks
  through registering the agent with the US Copyright Office ($6, renewed
  every 3 years) before any user uploads are added; the template has none
  today.
- **The operator's legal details** (minimum age, marketing postal address,
  DMCA agent, accessibility contact, consent-text version) in one `legal`
  section of `config.ts`, shipped as placeholders to replace before launch.
- **An operator guide**, `docs/compliance.md` in the generated project, that
  covers each risk, what the app does and what is still up to the operator.

None of it is legal advice, and the pages and guide say so.

---

## Template Variables

| Variable | Default | Options | Description |
|----------|---------|---------|-------------|
| `project_name` | My AI App | any string | Display name for the app |
| `project_slug` | my-ai-app | auto-generated | URL/directory-safe name |
| `project_description` | A full-stack AI-powered SaaS application | any string | Used in meta tags and README |
| `author_name` | Your Name | any string | Package author |
| `author_email` | you@example.com | any string | Package author email, and the ACME account address in the `Caddyfile` — a placeholder here means no `email` directive (see the [deployment guide](docs/deployment.md)) |
| `domain_name` | myapp.example.com | any string | Production domain. The `Caddyfile` serves and obtains a certificate for exactly this name |
| `primary_color` | #c2410c | any hex color | Brand color (DaisyUI primary) |
| `daisyui_theme` | dark | any DaisyUI theme | Base UI theme |
| `database_extensions` | none | none, pgvector | PostgreSQL extensions |
| `include_stripe` | yes | yes, no | Stripe billing integration |
| `include_marketing_extras` | yes | yes, no | Static JSON blog and contact form (with its API route) |
| `auth_providers` | google_microsoft | google_microsoft, google_only, microsoft_only | OAuth providers |
| `include_magic_link` | yes | yes, no | Email magic-link sign-in via Resend, independent of the OAuth choice. `no` drops its form, `/magic-link` page and provider; `RESEND_API_KEY` stays only if the contact form or Stripe is kept |
| `llm_provider` | ollama | ollama, openai, anthropic, openrouter | AI model provider. Sets `LLM_PROVIDER` and ships only that provider's credentials, in `.env.example`, the vault example and the env file a deploy renders. The worker's `settings.py` reads all four with defaults, so switching later means adding that provider's variables back, not changing code |
| `analytics` | none | none, posthog | Consent-gated product analytics. `posthog` adds a consent banner, a "Privacy choices" footer link, a first-party `/ingest` proxy and the `posthog-js` dependency, all idle until `POSTHOG_KEY` is set at runtime and a visitor accepts. `none` ships no analytics dependency, banner or provider code |
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
│   │   ├── legal/                 # /legal hub + one page per compliance topic
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
│   │   ├── schema.ts              # 10 tables + enums + relations
│   │   └── index.ts               # Drizzle connection pool
│   ├── queue/jobs.ts              # BullMQ dispatch + cancel
│   ├── redis.ts                   # ioredis singleton
│   ├── stripe.ts                  # Checkout + portal helpers
│   ├── checkout.ts                # One Stripe customer, one live subscription per user
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
│   │   ├── progress.py            #   Monotonic progress + per-step sub-ranges, cancellation
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
├── config.ts                      # Central app config (plans, resend, colors, auth, legal)
├── middleware.ts                   # Edge-safe route protection
├── postcss.config.js              # Tailwind 4 PostCSS plugin (theme lives in app/globals.css)
├── drizzle.config.ts              # Migration generator config
├── package.json                   # Node dependencies
├── package-lock.json              # Locked Node dependency tree (Dockerfiles use npm ci)
├── .github/dependabot.yml         # Weekly dependency update PRs
├── tsconfig.json                  # Strict TypeScript
├── .env.example                   # All env vars documented
├── scripts/
│   ├── migrate.sh                 # Database migrations (the migrator image's command)
│   └── check_compliance.sh        # Proves the /legal claims against a running app
├── tests/compliance/              # What check_compliance.sh asserts, in a headless Chrome
├── docs/compliance.md             # Operator guide to the legal risks the app handles
├── cli/
│   ├── src/                       # opsctl — status, logs, shell, over your own SSH
│   └── tsconfig.json              # Built by `npm run cli:build` / the `prepare` script
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

10 tables generated by default:

| Table | Purpose |
|-------|---------|
| `users` | User accounts (id, email, plan, isAdmin, stripeCustomerId) |
| `accounts` | OAuth provider accounts (NextAuth) |
| `sessions` | Active sessions (NextAuth) |
| `verification_tokens` | Email verification tokens (NextAuth) |
| `jobs` | AI processing jobs (status, type, input/output JSONB, progress) |
| `job_events` | Job progress events for SSE streaming |
| `subscriptions` | Stripe subscription records (recurring plans) |
| `purchases` | One-time Stripe checkout records (`mode: "payment"`) |
| `audit_logs` | User action audit trail |
| `contact_submissions` | Contact form submissions |

### Database Extensions

PostgreSQL is the only database. You can optionally enable:

- **pgvector** — Adds vector similarity search for embeddings. Docker image: `pgvector/pgvector:pg18`

---

## Post-Generation Setup

```bash
cd <project-slug>
./setup.sh
```

`./setup.sh` does the full job: checks Node.js and Docker are installed and
running, writes both `.env.local` (host mode) and `.env.docker.local`
(container mode) from `.env.example`, generates a `NEXTAUTH_SECRET`, prompts
for credentials for whichever optional features (Stripe, OAuth, Resend, the
configured LLM provider) survived generation, runs `npm ci`, brings up the
Docker Compose stack and waits for it to report healthy, generates and
applies database migrations, and finishes by printing how to start the dev
server, the Python worker, and the DB writer.

<details>
<summary>Manual setup (to understand or customize what the script does)</summary>

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

# 8. Start the DB writer (separate terminal). Unlike Next.js, this is a plain
#    node script and does not load .env.local on its own, so export it first:
set -a && source .env.local && set +a
npm run worker:db-writer
```

</details>

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

Provisioning and deploying are playbooks, not scripts — see the
[deployment guide](docs/deployment.md):

| Command | Description |
|---------|-------------|
| `ansible-playbook -i ansible/inventory.ini ansible/provision.yml` | Take a fresh VPS to a ready state |
| `ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass` | Build, ship, migrate and switch |
| `... ansible/deploy.yml -e deploy_targets=app` | Deploy one image |
| `... ansible/deploy.yml --tags preflight` | Check the vault and DNS, deploy nothing |
| `ansible-playbook -i ansible/inventory.ini ansible/backup.yml` | Install or update the backup schedule |

Operating a deployed instance is `opsctl`, not a `docker compose` invocation or
an `ansible-playbook` command remembered over SSH — see the
[deployment guide](docs/deployment.md):

| Command | Description |
|---------|-------------|
| `opsctl` | List every command |
| `opsctl config` | First-run check: host configured, vault encrypted, SSH reachable |
| `opsctl status` | Container status on the host |
| `opsctl logs <service>` | Logs from the host (`-f` to follow) |
| `opsctl shell <service>` | An interactive shell in a running service |
| `opsctl provision` | Provision the host |
| `opsctl deploy [targets...]` | Build, ship, migrate and switch |
| `opsctl migrate` | Run pending migrations, shipping nothing else |
| `opsctl secrets edit` | Edit `ansible/vault.yml` without decrypting it to disk |
| `opsctl backup` | Take a backup right now |
| `opsctl preflight` | Check the vault, DNS, host reachability and configuration; deploy nothing |

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
- A `caddy` service that terminates TLS (see the [deployment guide](docs/deployment.md))
- Only Caddy on the host's ports: the app, database and Redis are reachable
  only from inside the stack
- `.env-production` read by compose and injected as environment variables —
  the file itself is never mounted into a container, because it is `0600` and
  owned by the deploy account (see the [deployment guide](docs/deployment.md))

---

## Deployment

Provisioning a fresh VPS, deploying the stack, secrets, and TLS are covered in
the [deployment guide](docs/deployment.md).

---

## Customization Guide

Adding a table, a dashboard page, an API route, a pipeline step, and changing
the theme are covered in the [customization guide](docs/customization.md).
Everything about the shipped example agent — its loop, its bounds, and how to
add a tool it can call — is in the [agent guide](docs/agent.md).

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

## Database backups and operations

Taking and restoring database backups, and operating a deployed instance with
`opsctl`, are covered in the [deployment guide](docs/deployment.md).

---

## CI flag matrix

CI generates, typechecks, lints and builds eight named flag combinations (the `flag-matrix` job in `.github/workflows/generate-and-build.yml`). `python scripts/check_ci_matrix.py` fails if any value of any choice in `cookiecutter.json` is missing from the matrix, so a new choice value needs a matrix entry.

Six further jobs cover the parts no flag varies — serving, provisioning, deploying, backing up and operating:

| Job | What it proves |
|---|---|
| `proxy-config` | The `Caddyfile` names the `domain_name` that was answered, and carries an `author_email` as the ACME account only when mail could reach it. Each case also goes through `scripts/check_caddyfile.sh`: fully rendered, `caddy fmt`-clean, and accepted by `caddy validate` |
| `tls-stack` | Bringing up `docker-compose.prod.yml` serves the app over HTTPS with a certificate that verifies, redirects HTTP to it, and publishes no port but the proxy's. Runs `scripts/check_tls_stack.sh` |
| `provisioning` | The playbook lints clean, then takes a throwaway host from stock image to ready state and leaves it that way: root refused over SSH, the deploy user logging in with a key, only the expected ports open, upgrades and rotation active — and a second run that changes nothing. Runs `scripts/check_provisioning.sh` |
| `deploy` | The deploy playbook lints clean, the template ships a vault example and no vault, and every name in that example is prefixed `vault_`. Then a throwaway host is deployed to for real: secrets reaching it only as a `0600` file rendered from the encrypted vault and printed nowhere, even under `--diff`; the DNS pre-flight aborting when the served name resolves somewhere other than the target; migrations applied before the new containers serve; a deliberately broken release leaving the previous one still answering — and a second run that changes nothing. Runs `scripts/check_deploy.sh` |
| `backups` | The backup playbook lints clean, refuses an unencrypted vault and a retention policy of zero, then installs itself on a provisioned throwaway host and is held to every criterion as behaviour: a dump taken from a live Postgres that still contains its rows, that same dump byte-for-byte at a separate destination, the timer firing on its own, pruning that deletes the oldest and never the newest, a broken destination surfacing as an alert delivered off the host while deleting nothing — and a second run that changes nothing. Runs `scripts/check_backups.sh` |
| `cli` | `opsctl`'s own TypeScript type-checks and lints clean, its unit tests pass, and it installs from an npm `bin` entry (`npm link`) under a name that does not depend on `project_slug`. Then, against a throwaway host: `config` reports the placeholder host and missing vault before either exists; `provision` really runs `ansible/provision.yml` (and a second run changes nothing); `deploy` and `migrate` are refused by the real playbook's own checks (no vault, then an unknown target, then a nonsense platform that proves `migrate` builds only the migrator image); `preflight` fails on an unreachable host — the one thing `deploy.yml --tags preflight` cannot check itself — then passes once the host is reachable; `secrets edit` round-trips a change through a real `ansible-vault edit`; `backup` takes a real dump that reaches a stand-in destination; `status` and `logs` reflect a real Postgres and Redis, authenticating through nothing but a temporary block in the runner's own `~/.ssh/config`; `shell` opens a real interactive `exec` session, allocated a pty the way a terminal would; and `restore` explains itself rather than looking unknown. Runs `scripts/check_cli.sh` |

---

## Nightly stack health check

Bringing up real containers — app, worker, db-writer, postgres, redis — and running a real job through the queue and worker is too slow for every PR, and cheap once a night. `.github/workflows/nightly-stack-health.yml` generates a project, brings the full stack up, waits for every service to report Docker-healthy, and submits one job directly through Postgres and Redis to prove the queue/worker/db-writer pipeline actually runs end to end in real containers. A failure files (or comments on) a `nightly-failure`-labeled issue so it doesn't rely on anyone watching the Actions tab. Runs `scripts/check_stack_health.sh`.

---

## License

MIT — see [LICENSE](LICENSE).
