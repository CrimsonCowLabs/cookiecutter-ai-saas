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

`site/` is hand-written HTML and CSS: `index.html`, `styles.css`, and a small
number of static assets described below. There is no build step, no
framework and no third-party runtime dependency, and that is a constraint
rather than a stage the page has not outgrown yet. A page with no toolchain
cannot have a broken toolchain, and it is the fastest and most crawlable
thing this repo can serve.

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

## Search engines and link previews (issue #36)

`index.html`'s `<head>` carries a `<title>`, a `<meta name="description">`, a
`<link rel="canonical">`, and complete Open Graph and Twitter card tags, so
the page presents itself as a product rather than a repo slug wherever it is
shared. `scripts/check_site.py`'s `check_link_preview` enforces all of it:
the title's length against the ~60 characters a search result truncates at,
the description's length, the canonical URL matching the Pages URL exactly,
and every required `og:*`/`twitter:*` tag present with non-empty content —
including `og:image`/`twitter:image` resolving to a real file under `site/`
at the `1200x630` dimensions declared in `og:image:width`/`og:image:height`.
Widen what that function checks rather than adding a second place that knows
the same thing.

**Regenerating the preview image.** `site/og-image.png` is a build artifact
of `site/og-image.svg`, not a binary pasted in from nowhere. Regenerate it
with:

```bash
python scripts/generate_og_image.py
```

That script shells out to a local headless Chrome/Chromium to rasterize the
SVG — the one renderer guaranteed to agree with how the SVG's system-font
CSS actually looks in a browser — at exactly `1200x630`. It is a dev-time
tool, not a page dependency: nothing in `site/` references it, and
`scripts/check_site.py` does not run it. If no Chrome/Chromium is on `PATH`,
either install one normally or get a throwaway one with no system install:

```bash
npx --yes @puppeteer/browsers install chrome@stable --path /tmp/chrome-for-og
CHROME_PATH=$(find /tmp/chrome-for-og -name chrome -type f) \
    python scripts/generate_og_image.py
```

Edit `site/og-image.svg` and rerun the script; commit both the SVG and the
regenerated PNG.

**The sitemap.** `site/sitemap.xml` lists the one canonical URL and nothing
else. Unlike `robots.txt`, a sitemap is valid at the path it is served from
and below, so `site/sitemap.xml` is reachable at
`https://crimsoncowlabs.github.io/cookiecutter-ai-saas/sitemap.xml` even
though this repo does not own the host root. There is nowhere to put a
`Sitemap:` line pointing at it — that belongs in a `robots.txt` this repo
cannot have — so it is discoverable only by submitting it to a search
console, which is issue #40's job alongside flipping the indexing switch.
`scripts/check_site.py`'s `check_sitemap` checks it is well-formed XML and
lists the canonical URL; `ALLOWED_SUFFIXES` was widened to include `.xml` for
exactly this file, the deliberate widening the comment above it anticipated.

**Verifying a link preview renders.** `check_link_preview` above is the
repo's own linter for this and runs on every PR. It was also exercised
against a real consumer while shipping #36: `python -m http.server` inside
`site/`, a plain `curl` against it (reproducing what an unfurl bot's
no-JS HTTP GET sees), and `npx lighthouse --only-categories=seo` against a
locally served copy with the indexing hold stripped from a throwaway copy
only, never from the committed file, which scored SEO 100/100. Against the
unmodified page, with the hold in place, `is-crawlable` was the only SEO
audit that failed — everything else that hold does not touch (title,
description, canonical, link text, crawlable anchors, HTTP status) passed.

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
