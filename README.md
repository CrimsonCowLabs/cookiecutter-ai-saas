# cookiecutter-ai-saas

A cookiecutter template for scaffolding production-ready, full-stack AI SaaS
applications: Next.js + a Python AI worker, with auth, billing, background
jobs, and one-command VPS deployment.

> **Status: pre-release.** This template is being modernized ahead of its first
> tagged release — dependencies, the agent layer, and deployment tooling are all
> in flight. Not yet recommended for production use.

## Quick Start

### Via Cookiecutter CLI

```bash
pip install cookiecutter
cookiecutter gh:eodgooch/cookiecutter-ai-saas
```

### Non-Interactive

```bash
cookiecutter gh:eodgooch/cookiecutter-ai-saas \
  --no-input \
  project_name="Invoice AI" \
  database_extensions=pgvector \
  llm_provider=anthropic
```

---

## What You Get

Every generated project is a complete distributed system with **105 files**:

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
| `author_email` | you@example.com | any string | Package author email |
| `domain_name` | myapp.example.com | any string | Production domain |
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
│   │   ├── runner.py              #   3-step AI pipeline
│   │   ├── settings.py            #   Config from env vars
│   │   ├── llm_utils.py           #   LLM provider abstraction
│   │   ├── agents/                #   Standalone agents (research_agent.py)
│   │   ├── tools/                 #   Custom pipeline tools
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
├── docker-compose.prod.yml        # Prod: Caddy network
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
- Caddy reverse proxy network
- No exposed database/redis ports
- `.env-production` file mounted read-only

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

### Adding a New Pipeline Step

1. Create a tool in `workers/app/tools/my_step.py`
2. Add the step to `PIPELINE_STEPS` in `workers/app/runner.py`
3. The worker will automatically include it in the job pipeline

### Running the Research Agent

`workers/app/agents/research_agent.py` is a self-contained LangGraph agent
(built with `langchain.agents.create_agent`). It is not yet wired into the job
pipeline; it takes everything from its caller and knows nothing about Redis,
BullMQ, or `settings`:

```python
from agents.research_agent import run_research_agent, ResearchAgentError

report = await run_research_agent(
    "solar power",
    model=llm_utils.get_llm(),   # any LangChain chat model that supports tool calling
    tools=[my_tool],             # any LangChain tools; may be empty
    max_tool_calls=8,            # explicit bound; the call that would exceed it never runs
)
```

- The result is a `ResearchReport` (Pydantic). Output that does not satisfy the
  schema raises `ReportSchemaError`; a partial report is never returned.
- Bounds end the run with a typed error, not a hang: `ToolCallLimitReached`
  (the tool-call limit) and `RecursionBackstopReached` (the LangGraph
  `recursion_limit` backstop). All three subclass `ResearchAgentError`.
- Tests use a scripted fake model (`tests/fakes.py`), so they need no provider
  key or network. To try a ready-made search tool, add its package (for example
  `langchain-tavily` or `langchain-community`) with `poetry add` and pass the
  tool in `tools=`.

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

---

## License

MIT — see [LICENSE](LICENSE).
