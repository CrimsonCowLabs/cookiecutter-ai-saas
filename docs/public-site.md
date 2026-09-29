# Public site

The template's public landing page is served from GitHub Pages on this repo. The
facts below are settled and should not be re-derived: they are baked into the
install command, the canonical URL, the Open Graph tags, the sitemap and the
crawler-facing summary, so changing one means changing all of them.

## Canonical facts

| Fact            | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Repo            | `CrimsonCowLabs/cookiecutter-ai-saas`                   |
| Public URL      | `https://crimsoncowlabs.github.io/cookiecutter-ai-saas/` |
| Pages source    | GitHub Actions (not a branch)                            |
| HTTPS           | Enforced by Pages                                        |
| Custom domain   | None. Deliberate: no DNS to own or renew.                |

Watch the capitalisation. The org login is `CrimsonCowLabs`, which is what
appears in repo paths and in `cookiecutter gh:CrimsonCowLabs/cookiecutter-ai-saas`.
The Pages hostname is lowercase, because hostnames are: `crimsoncowlabs.github.io`.
Both spellings are correct in their own place; neither works in the other's.

The previous home, `eodgooch/cookiecutter-ai-saas`, redirects. Do not rely on the
redirect in anything published — use the canonical path above.

## Indexing is held back on purpose

The page is public but suppressed from search engines until the template is worth
finding. Billing does not yet work end to end and the guides the page links into
do not exist yet, so search traffic would arrive at a dead end.

The suppression is a single switch, and flipping it is the launch ticket's job and
nothing else's. If you are adding SEO or crawler metadata, add it fully and leave
the switch alone.
