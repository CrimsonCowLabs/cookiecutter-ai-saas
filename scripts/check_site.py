#!/usr/bin/env python3
"""Check the public landing page in site/ before it is deployed to Pages.

The page is hand-written static HTML and CSS on purpose (issue #33): no build
step, no framework, no runtime dependency on anything but GitHub Pages. That is
cheap to keep true only if something enforces it, because the usual way a static
page stops being static is one innocent <script src="https://cdn...">.

Issue #35 widened this on purpose, by exactly the amount its checklist needed:
a <script> is allowed now, but only inline. One with a `src` still fails,
local paths included — "first-party" is not an exemption from "no runtime
dependency", it is this page choosing to depend on nothing it does not ship
inline in its own HTML.

The repo path and install command asserted here are settled in
docs/public-site.md. Change them there and here together.

Usage: python scripts/check_site.py [site-dir]

The optional argument is how the checks themselves get tested: point it at a
deliberately broken copy of site/ and every assertion below should fail with a
message naming the problem.
"""

import pathlib
import re
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "{{cookiecutter.project_slug}}"

REPO = "CrimsonCowLabs/cookiecutter-ai-saas"
REPO_URL = f"https://github.com/{REPO}"
INSTALL_COMMAND = f"cookiecutter gh:{REPO}"

# A static page needs nothing else today. Widening this is a real decision
# rather than a formality: #36 will want .xml for a sitemap and #37 may want a
# JSON-LD <script>, and each should be allowed deliberately, by the ticket that
# needs it, so that "no build step" does not erode one convenience at a time.
ALLOWED_SUFFIXES = {".html", ".css", ".svg", ".png", ".ico"}

# Off-origin on an <a> is a link, which is the point. Off-origin anywhere else
# is a runtime dependency: the page stops rendering when that host does.
URL_ATTRS = {"src", "href", "srcset", "data", "poster"}
OFF_ORIGIN = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.I)

# A prompt character pasted along with the command is a broken paste.
PROMPT = re.compile(r"^[$>#]\s")

failures = []


def fail(message):
    failures.append(message)


class Page(HTMLParser):
    """Collects only what the assertions below need, in document order.

    Everything the checks look at comes from here rather than from a regex over
    the source, so there is one parse of the page and one place that knows how
    HTML is shaped.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.doctype = None
        self.metas = []            # attributes of every <meta>
        self.scripts = []          # True/False, has-a-src, one entry per <script>
        self.inline_handlers = []  # (tag, attr) for every on*= attribute
        self.off_origin = []       # (tag, attr, value) outside <a>
        self.links = []            # every <a href>
        self.html_attrs = {}
        self.pre_text = ""         # raw text inside <pre>, newlines intact
        self.text = []             # (tag, classes, normalised text)
        self._stack = []

    def handle_decl(self, decl):
        if self.doctype is None:
            self.doctype = decl

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.html_attrs = attrs
        elif tag == "meta":
            self.metas.append(attrs)
        elif tag == "script":
            self.scripts.append(bool(attrs.get("src")))
        elif tag == "a":
            self.links.append(attrs.get("href", ""))
        for attr, value in attrs.items():
            if attr.startswith("on"):
                self.inline_handlers.append((tag, attr))
            # A <script src> is rejected in full below, on-origin included, so
            # it is excluded here rather than reported twice under a message
            # that only makes sense for an off-origin one.
            if attr in URL_ATTRS and tag not in ("a", "script") and value and OFF_ORIGIN.match(value):
                self.off_origin.append((tag, attr, value))
        self._stack.append((tag, attrs.get("class", "").split()))

    def handle_endtag(self, tag):
        while self._stack:
            if self._stack.pop()[0] == tag:
                break

    def handle_data(self, data):
        if not self._stack:
            return
        if any(tag == "pre" for tag, _ in self._stack):
            # Kept verbatim: the line breaks are what makes it a command.
            self.pre_text += data
        if data.strip():
            tag, classes = self._stack[-1]
            self.text.append((tag, classes, " ".join(data.split())))

    def meta(self, name):
        """Every <meta name="..."> with this name, case-insensitively."""
        return [m for m in self.metas if m.get("name", "").lower() == name]

    def texts(self, tag, css_class=None):
        return [
            text for element, classes, text in self.text
            if element == tag and (css_class is None or css_class in classes)
        ]


def check_page_source_is_outside_the_template(site):
    # Generated projects must be unaffected by the landing page. Cookiecutter
    # only copies what lives under the template directory, so the one thing that
    # could go wrong is the page being put there.
    if TEMPLATE in site.resolve().parents or site.resolve() == TEMPLATE:
        fail(f"{site} is inside {TEMPLATE.name}: the page would ship in every generated project")
    stowaway = TEMPLATE / site.name
    if stowaway.exists():
        fail(f"{stowaway} exists: the page must not appear in generated output")


def check_no_build_step(site):
    for path in sorted(p for p in site.rglob("*") if p.is_file()):
        if path.name == "robots.txt":
            # See check_indexing below: on a project Pages site this file is
            # never read, so it can only be a second, ineffective copy of the
            # indexing decision for someone to flip and believe.
            fail(f"{path.relative_to(site)}: a project Pages site serves this from a subpath, "
                 "where no crawler reads it")
        elif path.suffix.lower() not in ALLOWED_SUFFIXES:
            fail(f"{path.relative_to(site)}: not a static asset, so the page has gained a build step")


def check_html(page):
    if (page.doctype or "").lower() != "doctype html":
        fail(f"expected <!doctype html>, found {page.doctype!r}")
    if not page.html_attrs.get("lang"):
        fail("<html> has no lang attribute")
    if not any("charset" in m for m in page.metas):
        fail("no <meta charset>")

    viewport = page.meta("viewport")
    if len(viewport) != 1:
        fail(f"expected exactly one <meta name=viewport>, found {len(viewport)}")
    elif "width=device-width" not in viewport[0].get("content", ""):
        fail("<meta name=viewport> does not set width=device-width, so phones render a zoomed-out desktop")

    if not page.texts("title"):
        fail("<title> is empty")

    with_src = sum(page.scripts)
    if with_src:
        fail(f"{with_src} <script src> element(s): a script may be inline but must not load "
             "from anywhere, this origin included")
    for tag, attr in page.inline_handlers:
        fail(f"<{tag} {attr}>: inline event handler is still JavaScript")
    for tag, attr, value in page.off_origin:
        fail(f"<{tag} {attr}=\"{value}\">: off-origin runtime dependency")


def check_indexing(page):
    """Check the indexing decision is coherent, not that it says any one thing.

    The page is held out of search by a single <meta name="robots"> tag, and #33
    requires that launching it stay a one-line change — so deleting that line has
    to leave CI green. What is checked is therefore the shape of the decision
    rather than its value: at most one tag, so flipping it cannot miss a copy,
    and if it is there it has to actually suppress indexing rather than say
    something that only looks like it does.

    robots.txt cannot take part in this. A project Pages site is served from a
    subpath and robots.txt is only read from the host root, which this repo does
    not own. A Disallow would be the wrong tool even if it were available: a
    crawler that is not allowed to fetch the page never reads the noindex, so
    the URL can still surface from an inbound link.
    """
    robots = page.meta("robots")
    if len(robots) > 1:
        fail(f"found {len(robots)} <meta name=robots> tags: the indexing decision has to be "
             "in one place, or flipping it will miss a copy")
        return
    if not robots:
        return "indexable"
    content = robots[0].get("content", "").lower()
    if "noindex" not in content:
        fail(f'<meta name=robots content="{content}"> neither says noindex nor is absent: '
             "say noindex to hold the page back, or delete the tag to launch it")
        return
    return "held out of search"


def check_hero(page):
    headings = page.texts("h1")
    if len(headings) != 1:
        fail(f"expected exactly one <h1>, found {len(headings)}")
    elif "cookiecutter-ai-saas" not in headings[0]:
        fail(f"<h1> does not name the product: {headings[0]!r}")

    # The one-sentence value proposition, named by the page rather than guessed
    # at: long enough to say who it is for, short enough to still be a sentence.
    tagline = page.texts("p", "tagline")
    if len(tagline) != 1:
        fail(f'expected exactly one <p class="tagline">, found {len(tagline)}')
    elif len(tagline[0]) < 60:
        fail(f"the value proposition is too short to say who this is for: {tagline[0]!r}")
    elif tagline[0].count(".") > 1:
        fail(f"the value proposition is more than one sentence: {tagline[0]!r}")

    # Copyable means one selectable block: a drag across it yields commands and
    # nothing else, with no prompt characters to paste by mistake.
    lines = [line.strip() for line in page.pre_text.splitlines() if line.strip()]
    if not lines:
        fail("the install command is not in a <pre> block, so it cannot be selected cleanly")
    elif INSTALL_COMMAND not in lines:
        fail(f"no line of the <pre> block is the install command {INSTALL_COMMAND!r}: {lines}")
    for line in lines:
        if PROMPT.match(line):
            fail(f"{line!r} carries a shell prompt, which is pasted along with the command")

    if not any(href.rstrip("/") == REPO_URL for href in page.links):
        fail(f"no link to the repo at {REPO_URL}")


def main():
    site = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "site"
    index = site / "index.html"
    indexing = None

    check_page_source_is_outside_the_template(site)
    if not index.is_file():
        fail(f"no such file: {index}")
    else:
        check_no_build_step(site)
        page = Page()
        page.feed(index.read_text())
        check_html(page)
        indexing = check_indexing(page)
        check_hero(page)

    for message in failures:
        print(f"FAIL: {message}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print(f"ok: {site} is a static landing page with a copyable install command, {indexing}")


if __name__ == "__main__":
    main()
