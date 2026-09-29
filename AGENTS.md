## Agent skills

### Issue tracker

Issues live as GitHub issues on `CrimsonCowLabs/cookiecutter-ai-saas` (`origin` remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); all exist in the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Public site

The landing page is hand-written static HTML in `site/`, served from GitHub Pages
at `https://crimsoncowlabs.github.io/cookiecutter-ai-saas/`. It has no build step
and is held out of search by one tag. Run `python scripts/check_site.py` after
touching it. See `docs/public-site.md`.
