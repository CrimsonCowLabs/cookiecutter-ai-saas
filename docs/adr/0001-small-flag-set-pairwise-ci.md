# 1. Keep the generation-time choices few, and test them pairwise

**Status:** Accepted. Issues [#9](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/9) and [#12](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/12).

## Context

The inherited template asked seven architectural questions, giving 768
combinations. That is more than can ever be tested, and several of the
questions weren't worth asking. One offered a single option, so it asked
nothing. Another added a geospatial database extension, which few AI products
need. Two marketing-page booleans were always answered the same way.

Every answer that removes files in `hooks/post_gen_project.py` can produce a
project that compiles in one combination and breaks in another. CI only
catches that if the combination is actually built.

## Decision

- Drop the single-option choice and the geospatial extension (`postgis` and
  `postgis_pgvector`). Keep pgvector, since vector search is what AI products
  tend to need. Merge the blog and contact form into one
  `include_marketing_extras` choice.
- Drop `auth_providers: all`, which generated the same thing as
  `google_microsoft`. Magic-link sign-in became its own `include_magic_link`
  choice instead ([#11](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/11)).
- A new choice has to earn its place. It must change the generated project in
  a way someone would actually choose differently. Later additions
  (`include_magic_link`, `analytics`, `llm_provider` gaining OpenRouter) cleared
  that bar.
- CI builds a roughly pairwise matrix (`flag-matrix` in
  `.github/workflows/generate-and-build.yml`) rather than every combination.
  `scripts/check_ci_matrix.py` fails the build if any value of any choice is
  never exercised, and prints pairwise coverage for information.
- Each matrix entry asserts its flags had the intended effect, for example that
  the Stripe files are absent when `include_stripe=no`. Building alone would
  miss a flag that silently did nothing.

## Consequences

- An interaction between three choices can still slip through. The matrix
  promises that every value is built and nearly every pair is covered. It does
  not promise every combination.
- Adding a value to a choice means adding a matrix entry. `check_ci_matrix.py`
  makes forgetting that a CI failure, not a silent gap.
- The generated file count depends on the answers, so docs state the count for
  the default answers and say that it varies.
