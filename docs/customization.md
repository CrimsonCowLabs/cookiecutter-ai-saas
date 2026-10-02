# Customization guide

The template ships one working pipeline (fetch a URL, hand it to a tool-calling
agent, report back) so a fresh clone does something real on day one. Everything
below is how you replace or extend pieces of it: a new table, a new dashboard
page, a new API route, a new pipeline step, a new theme.

This guide is about the shape of each kind of change and where it lives. For
the agent's tool-calling loop itself — the bounded research agent, its
tool-call budget, progress events, and how to add a tool the agent can call —
see the [agent guide](agent.md). The "Adding a pipeline step" section
below only covers the pipeline's own step list; it links out to that guide for
the AI step's internals.

## Adding a database table

Tables live in `lib/db/schema.ts`, one file for every table, enum and
relation. There is no separate export/index file to update — `lib/db/index.ts`
imports the whole module (`import * as schema from "./schema"`) and passes it
to `drizzle()`, so anything exported from `schema.ts` is immediately reachable
as `db.query.<table>`.

1. **Define the table.** Follow the existing conventions: `uuid("id").primaryKey().defaultRandom()`
   for the primary key, `snake_case` column names passed as the first argument
   (Drizzle maps them to the camelCase property automatically), and
   `.references(() => users.id, { onDelete: "cascade" })` for any foreign key
   to `users`.

   ```ts
   export const widgets = pgTable("widgets", {
     id: uuid("id").primaryKey().defaultRandom(),
     userId: uuid("user_id")
       .notNull()
       .references(() => users.id, { onDelete: "cascade" }),
     name: text("name").notNull(),
     createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
   });
   ```

2. **Add relations, if the table references or is referenced by another one.**
   Relations are declared separately from the table, with `relations()`, and
   grouped at the bottom of the file:

   ```ts
   export const widgetsRelations = relations(widgets, ({ one }) => ({
     user: one(users, {
       fields: [widgets.userId],
       references: [users.id],
     }),
   }));
   ```

   This is what makes `db.query.widgets.findMany({ with: { user: true } })`
   work; it is optional if you only ever query the table directly with
   `db.select()`/`db.insert()`.

3. **Add an enum first if a column needs one.** Enums are declared above the
   tables with `pgEnum("name", [...])` and referenced from a column like
   `status: jobStatusEnum("status").notNull().default("queued")`.

4. **Generate and apply the migration.**

   ```bash
   npm run db:generate   # drizzle-kit generate — diffs schema.ts against
                          # lib/db/migrations and writes a new .sql file
   npm run db:migrate    # drizzle-kit migrate — applies pending migrations
   ```

   `db:generate` is a static diff — it reads `schema.ts` and the migration
   history under `lib/db/migrations/`, it does not need a running database.
   `db:migrate` does, and applies against whatever `DATABASE_URL` points at.
   There is also `npm run db:push` (push the schema straight to the database,
   no migration file) for local iteration, and `npm run db:studio` to browse
   data with Drizzle Studio.

## Adding a dashboard page

Dashboard routes live under `app/(main)/dashboard/`, one directory per page,
next to the existing `settings/`, `admin/`, and `jobs/[id]/`.

1. **Create the page.**

   ```
   app/(main)/dashboard/my-page/page.tsx
   ```

   ```tsx
   export default function MyPage() {
     return (
       <div>
         <h1 className="text-2xl font-bold">My Page</h1>
       </div>
     );
   }
   ```

2. **The auth guard is automatic.** Every route under `dashboard/` is wrapped
   by `app/(main)/dashboard/layout.tsx`, which calls `auth()` and redirects to
   `config.auth.loginUrl` when there is no session — you don't add anything to
   get that protection, it's a property of the directory.

3. **Add a nav entry, if the page should show up in the sidebar.** The nav
   items are a plain array (`baseNavItems`) declared in `dashboard/layout.tsx`
   itself, not in the `Sidebar` component — `components/dashboard/sidebar.tsx`
   just renders whatever `navItems` array it's handed as a prop (and is also
   what the mobile drawer reuses, so there's one nav list to maintain):

   ```ts
   // app/(main)/dashboard/layout.tsx
   const baseNavItems = [
     { href: "/dashboard", label: "Overview", icon: "..." },
     { href: "/dashboard/my-page", label: "My Page", icon: "..." },
   ];
   ```

   `icon` is an SVG path string rendered inside a fixed `<svg>` wrapper by
   `Sidebar` — copy one from [heroicons](https://heroicons.com) (outline
   style) rather than hand-drawing one. The admin-only nav item is appended
   conditionally after this array, based on `currentUser.isAdmin` — follow
   that pattern if your page is also gated by something beyond "signed in".

## Adding an API route

Routes live under `app/api/`, one `route.ts` per path, exporting the HTTP
methods it handles (`GET`, `POST`, ...). The pattern used by every existing
route is **auth (if needed) → rate limit (if needed) → validate → process →
respond**, in that order — rate limit before you touch the body, so an
abusive caller pays for the limiter check and nothing else:

```ts
// app/api/my-route/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { myRouteInputSchema } from "@/lib/validations";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit(`my-route:${session.user.id}`, 10, 60);
  if (limited) return limited; // a ready-made 429 Response

  const parsed = myRouteInputSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // ... do the work with parsed.data ...

  return NextResponse.json({ ok: true });
}
```

A few things worth being precise about, since they're easy to mix up:

- **`checkRateLimit()` is for routes; `enforceRateLimit()` is for server
  actions.** Both wrap the same sliding-window limiter in `lib/rate-limit.ts`,
  but a route handler returns a `Response` (there's no caller to throw to),
  while a server action (`app/actions/*.ts`) throws, since it's called like a
  normal async function from a client component. Reach for the one that
  matches how your route is invoked.
- **Public routes skip the auth check, not the rate limit.** `app/api/contact/route.ts`
  has no signed-in user to key off, so it rate-limits by IP
  (`` `contact:${ip}` ``) instead of by user ID — never skip rate limiting
  just because a route is unauthenticated; those are exactly the routes most
  worth protecting.
- **Validate with a Zod schema from `lib/validations.ts`**, not ad hoc checks.
  Keeping schemas there means the same shape can be reused from a server
  action or a test.
- A route that streams (like `app/api/jobs/[id]/progress/route.ts`'s SSE
  endpoint) still does auth first and still returns a `Response`, just one
  backed by a `ReadableStream` instead of `NextResponse.json`. It's the same
  pattern, not a special case.

## Adding a pipeline step

The worker pipeline is `workers/app/runner.py`: a fixed, ordered list of steps
that always run end to end, where every step returns a structured `status`
instead of raising, so a job finishes even when a step fails to do its real
work. This section is about adding a step to that list; see the agent guide
([agent guide](agent.md)) for what happens inside the existing "AI Processing" step.

1. **Write the step function.** Add `_step_<name>` to `runner.py` (or import
   it from a tool module under `workers/app/tools/` if the logic is reusable
   or substantial). It receives `(input_data, context)` and must return a
   dict, never raise for an expected failure:

   ```python
   async def _step_enrich_data(input_data: dict, context: dict) -> dict:
       """Step: add something to the page already collected."""
       collected = context["step_results"].get("Data Collection", {})
       if collected.get("status") != "collected":
           return {"status": "skipped", "reason": "nothing_collected"}
       # ... do the work ...
       return {"status": "enriched", "extra": "..."}
   ```

   `context["step_results"]` accumulates every prior step's return value
   keyed by its display name, which is how later steps read earlier output
   (exactly how `_step_process_with_ai` reads `"Data Collection"` and
   `_step_generate_results` reads both). `context["progress"]` is a
   `StepProgress` scoped to this step's slice of the 0–100 bar
   (`workers/app/progress.py`) if you want to report finer-grained progress
   from inside a long-running step — see `_agent_progress_listener` in
   `runner.py` for a worked example.

2. **Register the function in `_execute_step`'s lookup:**

   ```python
   async def _execute_step(step_func_name: str, input_data: dict, context: dict) -> dict:
       steps = {
           "collect_data": _step_collect_data,
           "process_with_ai": _step_process_with_ai,
           "enrich_data": _step_enrich_data,       # new
           "generate_results": _step_generate_results,
       }
       ...
   ```

3. **Add an entry to `PIPELINE_STEPS`,** in the order it should run:

   ```python
   PIPELINE_STEPS = [
       ("Data Collection", "collect_data", 30),
       ("AI Processing", "process_with_ai", 40),
       ("Enrichment", "enrich_data", 10),          # new
       ("Results Generation", "generate_results", 20),
   ]
   ```

   The third number is the step's weight, not a percentage — `run_job`
   divides the 0–100 progress bar proportionally across all steps' weights,
   so lowering the other weights to make room is optional, not required (the
   math is a fraction of the total either way).

4. **Return a structured `status`, never let an expected failure raise.** The
   existing steps use a small, consistent vocabulary (`"collected"` /
   `"skipped"` / `"error"`, each with a `reason` when it's not the happy
   path) so that a later step, and ultimately `_step_generate_results`, can
   explain in the user-facing `summary` why a job didn't produce a full
   report. Follow that discipline for a new step too — an unhandled
   exception still fails the whole job, which is correct for a genuine bug,
   but wrong for an input your step should just decline gracefully.

`workers/app/tests/test_pipeline.py` includes `test_step_names_are_unchanged`,
which pins the existing step names because `worker.py`'s progress publishing
and the frontend key off them — add a corresponding test for your new step's
name if it's meant to be stable, and don't rename an existing step without
checking what reads that name downstream.

## Changing the theme

Tailwind 4 and DaisyUI 5 configure themes entirely in CSS, in
`app/globals.css`. There is no `tailwind.config.js` theme section to edit.

- **`@plugin "daisyui/theme" { ... }`** defines one named theme. The generated
  project's primary color lives here as `--color-primary` (plus
  `--color-primary-content` for text on top of it, and `--color-secondary`
  /`--color-secondary-content`). Change these values, or add another
  `@plugin "daisyui/theme" { name: "..."; ... }` block for a second custom
  theme.
- **`@plugin "daisyui" { themes: ...; }`** lists which themes are available at
  runtime and which is the default. The generator writes this from the
  `daisyui_theme` cookiecutter choice — for example choosing `dark` produces
  `themes: dark --default --prefersdark, light`, so the OS's dark-mode
  preference maps to your chosen theme and `light` stays available as a
  fallback. Add a theme name here (built-in DaisyUI theme names work too,
  with no `@plugin "daisyui/theme"` block needed) to make it selectable.
- **`config.ts`'s `colors.theme`** sets the active `data-theme` attribute on
  the root layout (`app/(main)/layout.tsx`). It has to name one of the themes
  listed in the `themes:` line above, or you get DaisyUI's own default
  instead of the one you meant.

Any `__PRIMARY_COLOR__`-style placeholders you might see if you read the
template's own source (as opposed to a generated project) are substituted by
`hooks/post_gen_project.py` from the `primary_color` and `daisyui_theme`
cookiecutter prompts — by the time you have a generated project, `globals.css`
and `config.ts` already have concrete values and nothing is templated.

This is the theme system for a *generated project*. The public landing page
at `site/` is a separate, hand-written page with its own Ember/Paper themes —
see [`docs/design-system.md`](design-system.md) for that one.
