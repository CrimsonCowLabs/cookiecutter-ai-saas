# 4. JSON-LD is serialized through one escaping helper

**Status:** Accepted. Issue [#29](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/29).

## Context

`lib/seo.tsx` puts structured data into `<script type="application/ld+json">`
tags with `dangerouslySetInnerHTML`, in four places. `JSON.stringify` doesn't
escape `<`, so a value containing `</script>` closes the tag early and anything
after it is parsed as HTML. That is a script injection.

Three of the call sites used static config or FAQ data. The fourth,
`renderArticleSchema`, interpolates a blog post's title, excerpt and tags. It
wasn't called anywhere when this was found, so the hole was latent. Wiring it
into the blog page, the obvious next step for anyone using the template, would
have made it live.

## Decision

All four call sites go through one helper, `jsonLd()` in `lib/seo.tsx`, which
replaces every `<` with `\u003c`. JSON parsers read that as the same character,
and an HTML parser never sees a tag boundary inside the script.

## Consequences

- A new JSON-LD block that skips `jsonLd()` reopens the hole. The helper sits
  beside the existing call sites so the pattern is the one you copy.
- Only `<` is escaped. That is enough to stop a script tag closing early. It
  doesn't make the data safe to put anywhere other than a JSON-LD script.
