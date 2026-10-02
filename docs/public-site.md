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
| Page source     | `site/` at the repo root                                 |
| Deploy workflow | `.github/workflows/public-site.yml`                      |
| HTTPS           | Enforced by Pages                                        |
| Custom domain   | None. Deliberate: no DNS to own or renew.                |

Watch the capitalisation. The org login is `CrimsonCowLabs`, which is what
appears in repo paths and in `cookiecutter gh:CrimsonCowLabs/cookiecutter-ai-saas`.
The Pages hostname is lowercase, because hostnames are: `crimsoncowlabs.github.io`.
Both spellings are correct in their own place; neither works in the other's.
A third spelling, `CrimsonCow Labs` with a space, is the firm's name as a human
reads it. It belongs in prose on the page and nowhere a machine parses.

The previous home, `eodgooch/cookiecutter-ai-saas`, redirects. Do not rely on the
redirect in anything published — use the canonical path above.

## How the page is built and deployed

`site/` is hand-written HTML and CSS: `index.html`, `styles.css`, and nothing
else. There is no build step, no framework and no third-party runtime
dependency, and that is a constraint rather than a stage the page has not
outgrown yet. A page with no toolchain cannot have a broken toolchain, and it is
the fastest and most crawlable thing this repo can serve.

Issue #35 spent one piece of that constraint, deliberately: `index.html` may
now carry `<script>`, but only inline, with no `src` — not to a CDN and not to
a local file either. That is still "no third-party runtime dependency" and
still no build step; it is the page shipping a few lines of its own
vanilla JS rather than depending on anything that isn't committed in the file
itself. The checklist's persistence and its Markdown copy button are built
that way, and nothing about the page's content stops working if the script
never runs — it only loses those two conveniences.

`.github/workflows/public-site.yml` uploads `site/` to Pages exactly as
committed, on every push to `main` that touches the page source. Pull requests
run the checks but do not deploy. `workflow_dispatch` redeploys an unchanged
page, which is what you want after changing the Pages settings themselves.

`scripts/check_site.py` enforces the constraints above, the repo path and
install command from the table, and the shape of the indexing decision below.
Run it directly:

```bash
python scripts/check_site.py
```

Pass it a path to check a copy instead of `site/`, which is how the checks get
tested: break a copy on purpose and watch the right assertion fail.

The page source lives at the repo root, outside `{{cookiecutter.project_slug}}/`,
so it does not reach generated projects. Cookiecutter only copies the template
directory; the check asserts the page has not wandered into it.

## Indexing is held back on purpose

The page is public but suppressed from search engines until the template is worth
finding. Billing does not yet work end to end and the guides the page links into
do not exist yet, so search traffic would arrive at a dead end.

The switch is one tag in `site/index.html`:

```html
<meta name="robots" content="noindex, nofollow" />
```

Deleting that line launches the page, and nothing else has to change with it.
That is the whole design: there is deliberately no second copy of the hold, and
`scripts/check_site.py` checks the *shape* of the decision rather than its value
— at most one robots tag, and if there is one it has to genuinely say `noindex`
— so the launch does not also have to be a CI change. The cost of that choice is
that CI will not notice the tag being deleted by accident; it is one line in the
`<head>` of a two-file site, so review will.

`robots.txt` cannot take part in this, now or later. A project Pages site is
served from a subpath, and `robots.txt` is only read from the host root —
`crimsoncowlabs.github.io/robots.txt`, which belongs to a different repo than
this one. A `site/robots.txt` would be published to a path no crawler reads, so
the checks reject the file outright rather than let it sit there looking load-
bearing. A `Disallow` would be the wrong tool even if the file were reachable:
a crawler that is not allowed to fetch the page never reads the `noindex`, so
the URL can still surface from an inbound link. The landing-page epic was
written before this was settled; #35-#38 and #40 have been corrected. Treat a
new ticket that asks for a file at the host root the same way.

Flipping the switch is the launch ticket's job and nothing else's. If you are
adding SEO or crawler metadata, add it fully and leave the switch alone.
