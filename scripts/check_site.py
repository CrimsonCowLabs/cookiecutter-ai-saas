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
import struct
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "{{cookiecutter.project_slug}}"

REPO = "CrimsonCowLabs/cookiecutter-ai-saas"
REPO_URL = f"https://github.com/{REPO}"
INSTALL_COMMAND = f"cookiecutter gh:{REPO}"
PAGE_URL = "https://crimsoncowlabs.github.io/cookiecutter-ai-saas/"

# A static page needs nothing else today. Widening this is a real decision
# rather than a formality: #36 will want .xml for a sitemap and #37 may want a
# JSON-LD <script>, and each should be allowed deliberately, by the ticket that
# needs it, so that "no build step" does not erode one convenience at a time.
# #36 is that first widening: site/sitemap.xml needs .xml, and nothing else.
ALLOWED_SUFFIXES = {".html", ".css", ".svg", ".png", ".ico", ".xml"}

# SERPs truncate a <title> somewhere around 60 characters of rendered width;
# there is no official limit, so this is a conservative character budget
# rather than a spec. og:title/twitter:title ride along with the same text
# and are not re-checked against this budget separately.
MAX_TITLE_LENGTH = 60

# Meta descriptions get cut off similarly, around 155-160 characters. Too
# short is also a real failure mode: an empty or token description gets
# replaced by whatever text Google scrapes from the page instead.
MIN_DESCRIPTION_LENGTH = 50
MAX_DESCRIPTION_LENGTH = 160

# The standard Open Graph size, and what og-image.png actually is. This is
# duplicated by necessity in three places that cannot share a constant: here,
# scripts/generate_og_image.py's WIDTH/HEIGHT, and the literal
# og:image:width/og:image:height content in site/index.html. Change all three
# together, the same way docs/public-site.md's table has to move with
# REPO/INSTALL_COMMAND above.
OG_IMAGE_WIDTH = 1200
OG_IMAGE_HEIGHT = 630

# Off-origin on an <a> is a link, which is the point. Off-origin anywhere else
# is a runtime dependency: the page stops rendering when that host does.
URL_ATTRS = {"src", "href", "srcset", "data", "poster"}
OFF_ORIGIN = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.I)

# A prompt character pasted along with the command is a broken paste.
PROMPT = re.compile(r"^[$>#]\s")

failures = []


def fail(message):
    failures.append(message)


def png_dimensions(path):
    """(width, height) of a PNG, read from its IHDR chunk. None if not a PNG."""
    with path.open("rb") as f:
        data = f.read(24)
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return struct.unpack(">II", data[16:24])


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
        self.link_tags = []        # attributes of every <link>
        self.html_attrs = {}
        self.pre_text = ""         # raw text inside <pre>, newlines intact
        self.text = []             # (tag, classes, normalised text)
        self._stack = []
        self._heading = None       # (tag, classes, [text so far]) while inside h1-h6

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
        elif tag == "link":
            self.link_tags.append(attrs)
        for attr, value in attrs.items():
            if attr.startswith("on"):
                self.inline_handlers.append((tag, attr))
            # A <script src> is rejected in full below, on-origin included, so
            # it is excluded here rather than reported twice under a message
            # that only makes sense for an off-origin one. A <link rel=canonical>
            # (or similar metadata-only rels) is never fetched by the browser at
            # all — it is read the way an <a href> is, by whatever follows it on
            # purpose, not loaded as part of rendering the page — so it is exempt
            # for the same reason <a> is, and a canonical URL has to be absolute
            # to mean anything.
            if (
                attr in URL_ATTRS
                and tag not in ("a", "script")
                # rel is an ASCII case-insensitive keyword per the HTML spec, so
                # this has to match Page.link()'s lower-casing or a perfectly
                # legitimate <link rel="Canonical"> would fail as a spurious
                # off-origin runtime dependency.
                and not (tag == "link" and attrs.get("rel", "").lower() == "canonical")
                and value
                and OFF_ORIGIN.match(value)
            ):
                self.off_origin.append((tag, attr, value))
        classes = attrs.get("class", "").split()
        if _is_heading(tag):
            # A heading cannot contain another; a browser closes the open one
            # first, and so does this.
            self._close_heading()
            self._heading = (tag, classes, [])
        self._stack.append((tag, classes))

    def handle_endtag(self, tag):
        while self._stack:
            if self._stack.pop()[0] == tag:
                break
        # Any </h1>-</h6> closes the open heading, as it does in a browser, so
        # a mismatched close tag cannot swallow the rest of the page into it.
        if _is_heading(tag):
            self._close_heading()

    def _close_heading(self):
        if self._heading is None:
            return
        heading_tag, classes, parts = self._heading
        self._heading = None
        text = " ".join("".join(parts).split())
        if text:
            self.text.append((heading_tag, classes, text))

    def handle_data(self, data):
        if not self._stack:
            return
        if any(tag == "pre" for tag, _ in self._stack):
            # Kept verbatim: the line breaks are what makes it a command.
            self.pre_text += data
        if self._heading is not None:
            # A heading's text is everything inside it, not just the text
            # whose immediate parent is the <h1>-<h6> itself: the hero's
            # <h1><span>cookiecutter-</span><span class="text-gradient">ai-saas</span></h1>
            # reads as one heading to a person, a screen reader and a crawler,
            # and has no direct text at all. So a heading's descendants are
            # joined into one entry, recorded once when it closes, and not
            # also recorded piecemeal under whatever inline tag held them.
            # Joined without a separator, exactly as adjacent inline elements
            # render — whitespace in the source is kept and normalised.
            self._heading[2].append(data)
            return
        if data.strip():
            tag, classes = self._stack[-1]
            self.text.append((tag, classes, " ".join(data.split())))

    def meta(self, name):
        """Every <meta name="..."> with this name, case-insensitively."""
        return [m for m in self.metas if m.get("name", "").lower() == name]

    def meta_property(self, prop):
        """Every <meta property="..."> with this property (Open Graph's spelling)."""
        return [m for m in self.metas if m.get("property", "").lower() == prop]

    def link(self, rel):
        """Every <link rel="..."> with this rel, case-insensitively."""
        return [l for l in self.link_tags if l.get("rel", "").lower() == rel]

    def texts(self, tag, css_class=None):
        return [
            text for element, classes, text in self.text
            if element == tag and (css_class is None or css_class in classes)
        ]

    def headings(self):
        """(level, text) for every h1-h6 that has text, in document order."""
        return [
            (int(element[1]), text)
            for element, _classes, text in self.text
            if _is_heading(element)
        ]


def _is_heading(tag):
    return len(tag) == 2 and tag[0] == "h" and tag[1] in "123456"


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


def check_heading_outline(page):
    """The outline is a single <h1> and no heading level is skipped.

    A screen reader or a crawler builds the page's outline from heading
    levels alone, not font size, so the sequence of levels has to behave like
    a real outline: going deeper always deepens by exactly one level, because
    you cannot open a subsection of a section that was never opened. Going
    back up any number of levels is fine — that is just closing one.
    """
    headings = page.headings()
    if not headings:
        fail("no headings found")
        return
    if headings[0][0] != 1:
        fail(f"the first heading is <h{headings[0][0]}>, not <h1>: the outline has to start there")
    prev = 0
    for level, text in headings:
        if level > prev + 1:
            fail(f"<h{level}> {text!r} follows nothing deeper than <h{prev}>: skips a heading level")
        prev = level


def _resolve_site_asset(url, site, label):
    """Path under site/ that an absolute PAGE_URL-rooted asset URL names.

    og:image and twitter:image have to be absolute URLs to mean anything to a
    consumer that has no notion of "relative to this page" (most don't), but
    that also means nothing stops one from quietly pointing at a path that
    does not exist, or at a different host entirely. This turns the URL back
    into a file so the rest of the check can look at what it actually is.
    """
    if not url.startswith(PAGE_URL):
        fail(f"{label} {url!r} is not rooted at {PAGE_URL!r}: a relative or off-site "
             "image URL is unreliable in link previews")
        return None
    asset = site / url[len(PAGE_URL):]
    if not asset.is_file():
        fail(f"{label} {url!r} names {asset}, which does not exist")
        return None
    return asset


def check_link_preview(page, site):
    """Everything a link-preview consumer (Slack, a tweet, a card validator,
    a search result) needs is present, non-empty, and actually true.

    This is deliberately redundant with a human eyeballing the page: a title
    that is one character over budget or an og:image that 404s is invisible
    in a browser tab and only shows up where the page is actually shared, so
    it is checked here instead of trusted to review.
    """
    titles = page.texts("title")
    page_title = titles[0] if titles else None
    if page_title and len(page_title) > MAX_TITLE_LENGTH:
        fail(f"<title> is {len(page_title)} characters, over the ~{MAX_TITLE_LENGTH} that search "
             f"results truncate at: {page_title!r}")

    descriptions = page.meta("description")
    page_description = None
    if len(descriptions) != 1:
        fail(f"expected exactly one <meta name=description>, found {len(descriptions)}")
    else:
        page_description = descriptions[0].get("content", "")
        if not (MIN_DESCRIPTION_LENGTH <= len(page_description) <= MAX_DESCRIPTION_LENGTH):
            fail(f"<meta name=description> is {len(page_description)} characters, outside the "
                 f"{MIN_DESCRIPTION_LENGTH}-{MAX_DESCRIPTION_LENGTH} that reads as a real "
                 f"description rather than a stub or a truncated one: {page_description!r}")

    canonical = page.link("canonical")
    if len(canonical) != 1:
        fail(f"expected exactly one <link rel=canonical>, found {len(canonical)}")
    elif canonical[0].get("href") != PAGE_URL:
        fail(f'<link rel=canonical> points at {canonical[0].get("href")!r}, not the Pages '
             f"URL {PAGE_URL!r}")

    # Every one of these has to exist, exactly once, with non-empty content —
    # the shape check_html already gives <meta charset> etc. A tag present
    # but empty passes a naive "is it there" grep and fails in the wild.
    required_og = [
        "og:type", "og:url", "og:site_name", "og:title", "og:description",
        "og:image", "og:image:width", "og:image:height", "og:image:alt",
    ]
    og = {}
    for prop in required_og:
        tags = page.meta_property(prop)
        if len(tags) != 1 or not tags[0].get("content", "").strip():
            fail(f"expected exactly one non-empty <meta property=\"{prop}\">, found {len(tags)}")
        else:
            og[prop] = tags[0]["content"]

    if og.get("og:url") not in (None, PAGE_URL):
        fail(f'og:url is {og["og:url"]!r}, not the Pages URL {PAGE_URL!r}')
    if "og:image:width" in og and og["og:image:width"] != str(OG_IMAGE_WIDTH):
        fail(f'og:image:width is {og["og:image:width"]!r}, not {OG_IMAGE_WIDTH} (the image shipped)')
    if "og:image:height" in og and og["og:image:height"] != str(OG_IMAGE_HEIGHT):
        fail(f'og:image:height is {og["og:image:height"]!r}, not {OG_IMAGE_HEIGHT} (the image shipped)')

    required_twitter = ["twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"]
    twitter = {}
    for name in required_twitter:
        tags = page.meta(name)
        if len(tags) != 1 or not tags[0].get("content", "").strip():
            fail(f"expected exactly one non-empty <meta name=\"{name}\">, found {len(tags)}")
        else:
            twitter[name] = tags[0]["content"]

    if twitter.get("twitter:card") not in (None, "summary_large_image"):
        fail(f'twitter:card is {twitter["twitter:card"]!r}, not "summary_large_image" '
             "(the card shape that actually shows the image large)")

    # <title>/<meta description> are the only source of truth for this copy;
    # og:title/twitter:title and og:description/twitter:description repeat it
    # rather than writing their own, so a future copy edit cannot update the
    # tab title and silently leave a stale version in the share card.
    for label, value in (("og:title", og.get("og:title")), ("twitter:title", twitter.get("twitter:title"))):
        if page_title and value and value != page_title:
            fail(f"{label} {value!r} does not match <title> {page_title!r}")
    for label, value in (
        ("og:description", og.get("og:description")),
        ("twitter:description", twitter.get("twitter:description")),
    ):
        if page_description and value and value != page_description:
            fail(f"{label} {value!r} does not match <meta name=description> {page_description!r}")

    # The image itself: declared once, used for both cards (a link preview
    # consumer does not care which tag it came from), and it has to be the
    # size it claims to be or it is cropped or stretched unpredictably.
    image_url = og.get("og:image")
    twitter_image_url = twitter.get("twitter:image")
    if image_url and twitter_image_url and image_url != twitter_image_url:
        fail(f"og:image {image_url!r} and twitter:image {twitter_image_url!r} disagree")
    if image_url:
        asset = _resolve_site_asset(image_url, site, "og:image")
        if asset is not None:
            dims = png_dimensions(asset)
            if dims is None:
                fail(f"{asset}: not a PNG (or too small to read a header from)")
            elif dims != (OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT):
                fail(f"{asset} is {dims[0]}x{dims[1]}, not the {OG_IMAGE_WIDTH}x{OG_IMAGE_HEIGHT} "
                     "declared in og:image:width/height")


def check_sitemap(site):
    """site/sitemap.xml exists, is well-formed, and lists the canonical URL.

    A sitemap is valid at the path it is served from and below, unlike
    robots.txt, so site/sitemap.xml is reachable where it lands even though
    this repo does not own the host root. It is found by submitting it to a
    search console (issue #40) rather than by a Sitemap: line in a
    robots.txt that cannot exist here — see docs/public-site.md.
    """
    sitemap = site / "sitemap.xml"
    if not sitemap.is_file():
        fail(f"no such file: {sitemap}")
        return

    try:
        root = ET.parse(sitemap).getroot()
    except ET.ParseError as error:
        fail(f"{sitemap}: not well-formed XML: {error}")
        return

    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    if root.tag != "{http://www.sitemaps.org/schemas/sitemap/0.9}urlset":
        fail(f"{sitemap}: root element is <{root.tag}>, expected <urlset> in the sitemap namespace")
        return

    locations = [loc.text.strip() for loc in root.findall("sm:url/sm:loc", ns) if loc.text]
    if PAGE_URL not in locations:
        fail(f"{sitemap} does not list the canonical URL {PAGE_URL!r}, found {locations}")


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
        check_heading_outline(page)
        check_link_preview(page, site)
        check_sitemap(site)

    for message in failures:
        print(f"FAIL: {message}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print(f"ok: {site} is a static landing page with a copyable install command, {indexing}")


if __name__ == "__main__":
    main()
