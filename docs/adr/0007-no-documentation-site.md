# 7. Documentation is a README and focused guides, not a docs site

**Status:** Accepted. Issue [#28](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/28).

## Context

The inherited README described a product that no longer matched the code.
Nothing documented deployment, the agent, or how to extend the template. A
documentation site would fix discoverability, but it is a maintenance
commitment: a build, hosting, navigation, and a second place for the docs to
drift out of date. A template with no users hasn't earned that.

## Decision

- `README.md` covers quickstart, stack, every generation-time choice and the
  architecture.
- Three guides for people using the template cover the rest:
  [deployment](../deployment.md), [the agent](../agent.md) and
  [customization](../customization.md). Other files in `docs/`, such as
  `public-site.md` and `design-system.md`, are for maintainers.
- Decisions are recorded here, in `docs/adr/`.
- Every command in those guides was run before they merged
  ([#46](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/pull/46)). No
  CI job re-runs them, so a change that breaks a documented command needs its
  doc updated in the same pull request.

This is about documentation only. The public landing page in `site/` is a
single static page on GitHub Pages, not a docs site, and it doesn't hold the
guides.

## Consequences

- The docs render on GitHub with no build step and live next to the code they
  describe, so a change and its doc update can land in the same pull request.
- There is no search and no versioned docs. Revisit this if the template gains
  enough users that people ask for them.
