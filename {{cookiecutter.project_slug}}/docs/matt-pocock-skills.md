# Using the Matt Pocock skills plugin

This project's conventions — where issues live, what triage labels mean, how
domain docs are laid out — are written down in `AGENTS.md` and `docs/agents/`
so that both human and AI contributors read the same rules. The
mattpocock-skills Claude Code plugin is a set of slash-command skills built
to consume exactly that kind of scaffolding:
ticket intake, triage, TDD, bug diagnosis, code review, domain modeling, and a
few adjacent workflows, all driven as AFK (away-from-keyboard) agentic
workflows rather than one-off chat turns.

This doc does not re-explain what each skill does — that lives in the
plugin's own `SKILL.md` files. It explains which skills are worth reaching for
on *this* template's stack (Next.js/TypeScript frontend, Python BullMQ worker,
Node.js db-writer, Ansible-driven VPS deploy), and how each one plugs into the
conventions `docs/agents/*.md` already establishes.

## One-time setup

Run `/setup-matt-pocock-skills` once, before using any other skill from this
plugin. It explores the repo and writes the per-repo configuration the other
skills read: which tracker issues live on, what the triage label strings are,
and where domain docs go.

On a project generated from this template, that exploration should find the
scaffolding already in place rather than a blank repo: `AGENTS.md` already
has an `## Agent skills` block, `docs/agents/issue-tracker.md` already says
issues live on GitHub, `docs/agents/triage-labels.md` already lists the five
canonical labels, and `docs/agents/domain.md` already describes the
single-context `CONTEXT.md` + `docs/adr/` layout. Expect the setup skill to
present that as what it found and ask for a one-word confirmation, not to
walk you through configuring any of it from scratch. If you change your
tracker, your label strings, or move to a multi-context domain layout later,
re-run it to update `docs/agents/*.md` in place.

## Tickets and triage

**`/to-tickets`** breaks a plan, spec, or conversation into vertical-slice
tickets and publishes them to "the configured tracker." On this project that
tracker is GitHub Issues on whatever repo `git remote -v` resolves to — see
`docs/agents/issue-tracker.md` for the exact `gh` invocations. Tickets land
with the `ready-for-agent` label from `docs/agents/triage-labels.md` applied
by default, so a freshly-published ticket is already agent-grabbable.

**`/triage`** moves issues (and, if your repo later turns on the "PRs as a
request surface" flag in `docs/agents/issue-tracker.md`, external PRs too)
through the five canonical triage roles. The role *names* the skill talks
about (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`) are mapped one-to-one to this repo's actual label strings in
`docs/agents/triage-labels.md` — edit that file's right-hand column if you
ever rename the labels, and `/triage` picks up the change without needing to
be told again. Triage also reads this repo's domain glossary (see below)
while it works out whether a report describes something that already exists.

## Implementing work

**`/implement`** is the top-level driver for turning a ticket into code: it
delegates to `/tdd` at agreed seams, runs typechecking and the test suite, and
calls `/code-review` before committing. On this stack that means, concretely,
running the frontend's typecheck/lint and `npm test`-style commands, the
Python worker's `poetry run pytest`, and whatever checks the db-writer package
defines, rather than inventing a one-off verification step per ticket.

**`/tdd`** is the red-green loop itself. The template has three natural test
seams, and a ticket usually touches exactly one: the Next.js app (server
actions, API routes, components), the Python worker (`workers/app`, already
tested with a scripted fake model and an injected fake fetcher — see the
README's "Running the worker tests" section), and the Node.js db-writer
(`workers/db-writer`). Agree the seam before writing a test, same as the
skill says, and read the root `CONTEXT.md` first if one exists yet (see
"Domain modeling" below) so test names use the project's own vocabulary
instead of ad hoc synonyms.

**`/codebase-design`** is vocabulary, not a workflow to run on its own: reach
for it when a ticket's shape is unclear across this template's module
boundaries — is a piece of logic a Next.js server action, a BullMQ job
handler in the Python worker, or a step in the Node db-writer — and you need
language for where the seam should live and how deep the resulting module
is. `/tdd` and `/implement` both pull this in when the interface itself is in
question.

## Diagnosing and reviewing

**`/diagnosing-bugs`** is the discipline for anything broken or slow across
the stack: a bad job result from the worker, a stuck BullMQ queue, a failing
deploy health check, a slow query against the Drizzle schema. Its tightest
feedback loops on this template are usually a failing `pytest` case in
`workers/app`, a scripted request against a running `npm run dev` server, or
(per the README's "Smoke-testing before DNS exists" section) a local
`docker-compose.prod.yml` run with `SITE_ADDRESS=https://localhost` for
anything that only breaks in the production-shaped stack.

**`/code-review`** reviews a diff on two axes — does it follow this repo's
documented standards, and does it match the originating ticket. It reads
`docs/agents/issue-tracker.md` to fetch the originating issue by number from
commit messages, and treats anything this repo documents as coding standards
(a `CODING_STANDARDS.md` or `CONTRIBUTING.md`, if one is added) as
overriding its built-in smell baseline. Run it as the last step of
`/implement`, or stand-alone with `since main` or a commit SHA when reviewing
someone else's branch.

## Domain modeling

**`/domain-modeling`** builds and sharpens this project's glossary as you work
— `docs/agents/domain.md` already tells every other skill to read `CONTEXT.md`
and `docs/adr/` before exploring the codebase and to use the glossary's terms
instead of drifting into synonyms. Neither file exists yet in a freshly
generated project, and per `docs/agents/domain.md` that absence is expected:
this skill creates `CONTEXT.md` lazily, the moment a term in this domain
(a "Job", a "Report," whatever your first ticket actually names) is resolved
in conversation, and `docs/adr/` the moment a hard-to-reverse, non-obvious
decision needs recording — the choice to route a piece of work through the
Python worker's BullMQ queue rather than inline in a server action, or a
database schema change that has to stay backward-compatible across a deploy
(see the README's deploy ordering), are the kind of call this is for.

## Git and infrastructure

**`/resolving-merge-conflicts`** applies as-is to this repo, same as any git
repo: resolve the conflicting hunks against the original intent, then run
whatever this project's checks are (typecheck, `pytest`, lint) before
finishing the merge or rebase.

**`/wizard`** is worth reaching for specifically because of this template's
Ansible-driven deploy: generating a one-off interactive script for the manual,
non-agent-automatable parts of getting a fresh VPS and its secrets into
shape — populating `ansible/vault.yml` the first time, walking a Stripe or
OAuth provider dashboard for keys referenced in `.env.example`, pointing DNS
at a new host before the first deploy. It is not a replacement for
`ansible/provision.yml` or `ansible/deploy.yml` themselves (those are already
automated and documented in the README); it is for the steps upstream of them
that only a human with dashboard access can do.

## Skills left out of this doc

The plugin ships other engineering skills (`/prototype`, `/research`,
`/grilling`, `/writing-for-agents`) and a `productivity`/`misc` category.
They work the same way here as in any repo and don't interact with this
template's own conventions any differently, so they're not covered above —
consult their own `SKILL.md` files directly if you reach for them.
