## Agent skills

### Issue tracker

Issues live as GitHub issues on this repo (the `origin` remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); create them in the repo's label set before relying on them. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Compliance

`docs/compliance.md` is the operator guide to the legal risks this app handles. Each risk is explained to visitors on a page under `/legal`, and `scripts/check_compliance.sh` proves what those pages say against a running app. When a change affects one of those risks, update its `/legal` page and its section of the guide too.

Rules:

- **No off-origin requests before consent.** No page may make the visitor's browser contact another server until the visitor has opted in. Load fonts with `next/font`, self-host assets, and never add a `<link>`, `<script>` or `@import` pointing at another host. `tests/compliance/third-party-requests.test.mjs` enforces this against a running app.
- **Every new account passes the age gate.** Accounts are created only by Auth.js, whose `signIn` callback and `createUser` in `lib/auth.ts` refuse a new account without a passed age check (`lib/age-check.ts`). Don't add another way to insert into `users`, don't loosen that check, and never store, log or put in a cookie or URL the date of birth. `tests/compliance/age-gate.test.mjs` enforces this.
- **WCAG 2.2 AA on every page.** Render each page's content inside `<Main>` from `components/ui/skip-link.tsx`, and add every page you add to the page lists in `tests/compliance/accessibility.test.mjs`, which runs axe-core in both themes and checks the skip link and focus outlines. Don't remove or override the `:focus-visible` ring in `app/globals.css`, and keep muted text at `text-base-content/60` or stronger.
