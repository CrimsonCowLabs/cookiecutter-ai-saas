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
│   ├── deploy.sh                  # VPS deployment
│   └── migrate.sh                 # Database migrations
├── ansible/
│   ├── provision.yml              # Takes a fresh VPS to a ready state
│   ├── inventory.ini              # The host to provision
│   ├── group_vars/all.yml         # Deploy account, open ports, log caps
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
| `./scripts/deploy.sh full` | Build and deploy all services |
| `./scripts/deploy.sh app` | Deploy app only |

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
- `.env-production` file mounted read-only

---

## Provisioning the host

Deploying assumes a host that already has a deploy account, a firewall and a
container runtime. `ansible/provision.yml` is what puts them there. It is
separate from `scripts/deploy.sh` on purpose: it runs when a server is new and
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
| Deploy account | A user named from `author_name`, key-only, passwordless sudo, in the `docker` group — the account `scripts/deploy.sh` logs in as |
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
- **No application.** Provisioning ends at a ready host; `scripts/deploy.sh`
  takes it from there.

---

## HTTPS

TLS needs no step of its own. The stack runs its own Caddy, generated from the
`domain_name` you answered, which obtains a certificate from Let's Encrypt on
first boot, renews it, and redirects HTTP to HTTPS — so once the stack is up,
HTTPS is up. There is no external proxy to stand up and no network to create by
hand.

Bringing the stack up still means what it did before: `docker-compose.prod.yml`
has no build context, so `./scripts/deploy.sh full` builds the images and ships
them, and `.env-production` has to exist next to the compose file or compose
aborts. Nothing about the proxy changes that.

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

## CI flag matrix

CI generates, typechecks, lints and builds eight named flag combinations (the `flag-matrix` job in `.github/workflows/generate-and-build.yml`). `python scripts/check_ci_matrix.py` fails if any value of any choice in `cookiecutter.json` is missing from the matrix, so a new choice value needs a matrix entry.

Three further jobs cover deployment, which no flag varies:

| Job | What it proves |
|---|---|
| `proxy-config` | The `Caddyfile` names the `domain_name` that was answered, and carries an `author_email` as the ACME account only when mail could reach it. Each case also goes through `scripts/check_caddyfile.sh`: fully rendered, `caddy fmt`-clean, and accepted by `caddy validate` |
| `tls-stack` | Bringing up `docker-compose.prod.yml` serves the app over HTTPS with a certificate that verifies, redirects HTTP to it, and publishes no port but the proxy's. Runs `scripts/check_tls_stack.sh` |
| `provisioning` | The playbook lints clean, then takes a throwaway host from stock image to ready state and leaves it that way: root refused over SSH, the deploy user logging in with a key, only the expected ports open, upgrades and rotation active — and a second run that changes nothing. Runs `scripts/check_provisioning.sh` |

---

## License

MIT — see [LICENSE](LICENSE).
