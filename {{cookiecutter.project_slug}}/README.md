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
- **Deployment:** Docker, Caddy reverse proxy

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
  db-writer/            # Node.js DB writer
scripts/
  deploy.sh             # Deployment script
  migrate.sh            # Migration runner
```

## License

Private
