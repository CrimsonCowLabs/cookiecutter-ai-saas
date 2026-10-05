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
that way, as are the theme toggle, the progress counter and the install
command's copy button (see "Look and themes" below), and nothing about the
page's content stops working if the script never runs — it only loses those
conveniences.

Issue #37 added a second `<script>`, of a different kind: a
`<script type="application/ld+json">` block of structured data (see "AI
assistants and structured data" below). A browser never executes it, so it is
data rather than a runtime dependency, and it is the only other script type
the checks admit. "The inline script" below still means the one classic
script; it is the only JavaScript on the page.

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

## Look and themes

The page's visual design comes from the AI SaaS design system (the claude.ai
design project "Cookiecutter AI-SaaS design themes", screen "Project Page",
which maps to `site/index.html` + `site/styles.css`). That system is built
DaisyUI-style — every colour, radius and depth is a CSS variable, and
components are plain classes (`btn btn-primary`, `badge`, `surface-card`,
`navbar`, `section`, …) — so `styles.css` is a hand copy of just the tokens
and classes this page uses, under the same names. No design-system CSS, JS
or font is loaded at runtime. The design uses Inter and JetBrains Mono from
Google Fonts; this page uses system-font stacks instead, because a CDN font
is an off-origin runtime dependency.

There are two themes, set by `data-theme` on `<html>`: **Ember** (warm dark,
the page's original palette) and **Paper** (light). The design project also
explored a third, "Slate"; it was deliberately not shipped. With no
`data-theme`, CSS alone picks Ember or Paper from `prefers-color-scheme`, so
the page is correctly themed with its script off. The script adds an
Ember/Paper toggle to the navbar. Picking the theme the system does *not*
ask for sets `data-theme` and remembers it in `localStorage` under
`cookiecutter-ai-saas-theme`; picking the one it does ask for clears that
override, so there is always a way back to following the system. The Paper
variables appear twice in `styles.css` (once in the `prefers-color-scheme:
light` block, once under `[data-theme="paper"]`); keep the two identical.

The script lives in `<head>` rather than at the end of `<body>` so a
remembered theme is applied before first paint, instead of flashing the
other one; everything else in it waits for `DOMContentLoaded`. It is still
the page's one inline classic script (the JSON-LD block is data, not
code). Besides the theme toggle it restores and saves checklist state (`cookiecutter-ai-saas-checklist`, keyed by each checkbox's
`data-id` — don't rename those, or returning visitors lose their progress),
shows the done/total counter and progress bar, and adds the "Copy as
Markdown" and install-command copy buttons. Every one of those controls is
inserted or revealed by the script, so none sits on the page doing nothing
when it doesn't run.

The install command's `$ ` prompts are CSS `::before` generated content, not
text in the HTML, so they are never selected or copied — and never seen by
`check_site.py`'s prompt check, which only sees real text. Don't "simplify"
them into a `<span>$ </span>`: `user-select: none` does not take a text node
out of the DOM, and the check will fail.

[`docs/design-system.md`](design-system.md) has the concrete reference for
all of this: the Ember/Paper token tables, derived tokens, typography scale
and the component class catalog — use it instead of re-deriving values from
`styles.css` by hand.

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

## AI assistants and structured data (issue #37)

The page is written to be quoted: an assistant asked for a full-stack AI SaaS
starter should find everything it needs to name it, describe it and give the
install command, in the served HTML, without running JavaScript or guessing
from the README.

**Structured data.** One `<script type="application/ld+json">` in
`index.html` carries a schema.org `@graph` of three nodes:

- `Organization` — CrimsonCow Labs, `https://crimsoncowlabs.com`, with
  `sameAs` the `CrimsonCowLabs` GitHub org.
- `SoftwareSourceCode` — named `cookiecutter-ai-saas`, `url` the Pages URL,
  `codeRepository` the repo, `license` MIT (`https://spdx.org/licenses/MIT.html`,
  the same licence as `LICENSE`), its `programmingLanguage`s, and the
  Organization above as `maintainer` by `@id`. Not as `author`: `LICENSE`
  names an individual as copyright holder, and the data must not disagree.
- `FAQPage` — the page's FAQ, as `Question`/`Answer` pairs.

`scripts/check_site.py`'s `check_structured_data` checks each of those values
against the canonical facts above, not just that a value is there.

**The FAQ is the single source.** The visible FAQ (`#faq`, one `.faq-item`
per question with an `h3.faq-q` and one `p.faq-a`) is the copy; the `FAQPage`
repeats it. `check_structured_data` requires the questions to match in
order and every answer to match the visible answer's text, whitespace aside —
Google requires FAQ markup to match what the page shows, and it is the same
rule as `og:title` repeating `<title>`. Edit both together. `check_faq`
requires the questions #37 asks for by `data-faq` id (`what-is-it`,
`who-is-it-for`, `cost`, `prerequisites`, `vs-scratch`, `commercial-use`)
rather than by wording, so the copy can change without the check. The
licence is stated on the page with a link to `LICENSE` (`check_licence`), and
`#commercial-support` is the one sentence saying commercial support is
available from CrimsonCow Labs, with a link to its site
(`check_commercial_support`).

**`llms.txt`.** `site/llms.txt` is a plain-text summary in the llms.txt shape
(`# ` heading, `> ` summary, then what the project is and includes, the
install command, the repo and where to get help). The convention puts it at
the host root, which belongs to another repo here, so it is served at
`https://crimsoncowlabs.github.io/cookiecutter-ai-saas/llms.txt` and the page
links to it. A crawler that follows links finds it; one that only probes
`/llms.txt` does not. That is accepted: a custom domain is the only fix, and
there deliberately isn't one. `check_llms_txt` checks the file and the link.

**What #37 widened.** `ALLOWED_SUFFIXES` gained `.txt`, and
`check_no_build_step` admits exactly one `.txt` file, `llms.txt` at the top
of `site/` — `robots.txt` is still rejected by name. Script types widened
from "classic, inline" to that plus `application/ld+json`; any other `type`
fails, and no script may have a `src`. None of the FAQ, support statement or
structured data may be built by the inline script
(`check_content_without_javascript`): the checks read the served HTML, which
is what a no-JS crawler sees, so finding them there is the proof they work
without it.

**Don't fabricate claims.** Every fact in the structured data, the FAQ and
`llms.txt` must be true of the current template. An assistant repeats what it
finds, so an inflated claim becomes a support burden. Add a property only if
it is true today, and change it in the same PR that makes it untrue.

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
