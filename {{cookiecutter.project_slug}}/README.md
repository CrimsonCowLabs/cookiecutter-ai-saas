# {{ cookiecutter.project_name }}

{{ cookiecutter.project_description }}

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19
- **Language:** TypeScript (strict), Python {{ cookiecutter.python_version }}
- **Styling:** Tailwind CSS 4 + DaisyUI 5
- **Database:** PostgreSQL 18, Drizzle ORM
- **Auth:** NextAuth v5 (JWT sessions, OAuth)
- **Queue:** BullMQ (Redis-backed)
- **Payments:** Stripe (subscriptions)
- **Email:** Resend
- **Deployment:** Docker Compose, Caddy reverse proxy (TLS in the stack)

## Getting Started

### Prerequisites

- Node.js {{ cookiecutter.node_version }}+
- Python {{ cookiecutter.python_version }}+
- Docker & Docker Compose
- PostgreSQL 18
- Redis 7

### Setup

1. **Install dependencies:**

```bash
npm ci
```

2. **Configure environment:**

```bash
cp .env.example .env.local
# Edit .env.local with your credentials
```

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
| `./scripts/deploy.sh full` | Build & deploy all |
| `./scripts/deploy.sh app` | Deploy app only |

## Deployment

```bash
./scripts/deploy.sh full
```

See `scripts/deploy.sh` for available targets: `app`, `worker`, `db-writer`, `migrator`, `ops`.

### HTTPS

TLS needs no step of its own. The production stack runs its own Caddy, so once
the stack is up, HTTPS is up: Caddy obtains a certificate for
`{{ cookiecutter.domain_name }}` from Let's Encrypt on first boot, renews it, and
redirects HTTP to HTTPS. Nothing else publishes a port — the app, PostgreSQL and
Redis are reachable only from inside the stack.

Bringing the stack up is still `./scripts/deploy.sh full`: `docker-compose.prod.yml`
has no build context, so the images have to be built and shipped, and
`.env-production` has to exist next to the compose file or compose aborts.

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

## Project Structure

```
app/                    # Next.js App Router pages
  (main)/               # Main route group
    (auth)/             # Auth pages (sign-in, sign-up)
    dashboard/          # Authenticated area
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
  deploy.sh             # Deployment script
  migrate.sh            # Migration runner
Caddyfile               # TLS and HTTP->HTTPS for {{ cookiecutter.domain_name }}
```

## License

Private
