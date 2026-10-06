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
