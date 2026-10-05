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

Issue #37 widened it twice more, the same way. A <script type="application/ld+json">
is admitted, because JSON-LD is data a crawler reads, not code a browser runs;
no other script type is. And site/llms.txt is admitted, as the one .txt file
the page has a use for. Both come with checks that they say something true:
the structured data has to agree with the visible page and the repo, and the
FAQ it exposes has to be the FAQ a person reads, word for word.

Issue #38 is the ticket that spends #33's "no third-party runtime dependency",
because measurement and a contact form cannot be had on Pages without one. It
spends it by name, not in general: THIRD_PARTY below lists every off-origin URL
the page may touch, where, and why. One script may now have a `src` — the
Cloudflare Web Analytics beacon, deferred so it never blocks rendering — and
the form may post to the firm's own server, as the inline script may for its
click counts. Anything else off-origin still fails exactly as before. The
same ticket leaves placeholders for what only the author can supply (the
engagements' names and prices, the beacon token), and check_placeholders fails
while any remains, so the page cannot ship one by accident.

Everything here reads the served HTML, which is exactly what a crawler that
does not run JavaScript sees. So a check that finds the FAQ, the support
statement or the structured data in index.html is already proof that they are
there with scripts off; nothing has to render the page to know it.

The repo path and install command asserted here are settled in
docs/public-site.md. Change them there and here together.

Usage: python scripts/check_site.py [site-dir]

The optional argument is how the checks themselves get tested: point it at a
deliberately broken copy of site/ and every assertion below should fail with a
message naming the problem.
"""

import json
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
# rather than a formality: each widening should be allowed deliberately, by the
# ticket that needs it, so that "no build step" does not erode one convenience
# at a time. #36 was the first: site/sitemap.xml needs .xml, and nothing else.
# #37 is the second: site/llms.txt needs .txt — and only that file, so
# check_no_build_step admits no other .txt (robots.txt least of all, see
# check_indexing). #37's JSON-LD lives inside index.html and needed a script
# type widened rather than a suffix; see SCRIPT_TYPES.
ALLOWED_SUFFIXES = {".html", ".css", ".svg", ".png", ".ico", ".xml", ".txt"}
LLMS_TXT = "llms.txt"

# The only <script> types the page may carry. The empty string and
# text/javascript are the same thing — the inline classic script #35 allowed,
# spelled with or without its redundant type. application/ld+json is #37's
# structured data: the browser never executes it, so it is data, not a runtime
# dependency. Anything else (module, a template type, a framework's
# text/x-whatever) is a new kind of runtime and would have to be admitted on
# purpose by the ticket that needs it.
CLASSIC_SCRIPT_TYPES = {"", "text/javascript"}
JSON_LD = "application/ld+json"
SCRIPT_TYPES = CLASSIC_SCRIPT_TYPES | {JSON_LD}

# The facts the structured data asserts, held here so the checks can say they
# are true rather than merely present. The licence is the repo's LICENSE file,
# which is MIT (asserted against the file itself, in check_licence); SPDX's
# page is the canonical, version-free URL for that licence.
SCHEMA_ORG = "https://schema.org"
PROJECT_NAME = "cookiecutter-ai-saas"
LICENSE_URL = "https://spdx.org/licenses/MIT.html"
LICENSE_FILE_URL = f"{REPO_URL}/blob/main/LICENSE"
ORG_NAME = "CrimsonCow Labs"
ORG_URL = "https://crimsoncowlabs.com"
ORG_GITHUB = "https://github.com/CrimsonCowLabs"

# The questions #37 requires the FAQ to answer, by the data-faq id on each
# .faq-item rather than by wording, so the copy can be edited without editing
# this list. More items are fine; missing one of these is not.
REQUIRED_FAQ_IDS = (
    "what-is-it",        # what is it
    "who-is-it-for",     # who is it for
    "cost",              # what does it cost
    "prerequisites",     # what do I need before starting
    "vs-scratch",        # how is it different from starting from scratch
    "commercial-use",    # can I use it commercially
)

# Strings the inline classic script would have to contain to build the FAQ,
# the support statement or the structured data at runtime. None of them has
# any business in it: those are content, and content is in the served HTML.
SCRIPT_MUST_NOT_BUILD = ("faq", "commercial-support", "ld+json", "llms.txt")

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

# The third-party allowance #38 made, and all of it: each URL, the one way the
# page may use it, and why. #33 ruled out any third-party runtime dependency
# for a page that needed none; #38 needs measurement, and GitHub Pages gives no
# server logs, so it is a beacon or no numbers. Add to this only from a ticket
# that says why — an ad network or a tag manager would need that conversation
# again, not a line here.
#
# The uses are the places in the page a URL may appear. BEACON_REPORTS is the
# one the page never writes: the beacon's own requests to Cloudflare, listed
# because the page does talk to that origin, but allowed nowhere in the HTML —
# naming it in the markup or the inline script still fails.
SCRIPT_SRC = "script src"
FORM_ACTION = "form action"
INLINE_SCRIPT = "inline script"
BEACON_REPORTS = "sent by the beacon"
BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js"
BEACON_REPORT_URL = "https://cloudflareinsights.com"
CONTACT_URL = "https://crimsoncowlabs.com/api/cookiecutter/contact"
EVENT_URL = "https://crimsoncowlabs.com/api/cookiecutter/event"
THIRD_PARTY = {
    BEACON_URL: (frozenset({SCRIPT_SRC}), "Cloudflare Web Analytics beacon: cookieless "
                 "pageviews, since Pages keeps no logs (#38)"),
    BEACON_REPORT_URL: (frozenset({BEACON_REPORTS}), "where the beacon reports each pageview "
                        "(page URL, referrer, browser type; no cookie); the page itself never "
                        "names it (#38)"),
    CONTACT_URL: (frozenset({FORM_ACTION, INLINE_SCRIPT}), "contact form endpoint on the "
                  "firm's server, which emails the enquiry via Resend (#38)"),
    EVENT_URL: (frozenset({INLINE_SCRIPT}), "call-to-action click counter on the firm's "
                "server: daily counts, no cookies, no IP or user agent kept (#38)"),
}
SCRIPT_SRC_ALLOWED = {url for url, (uses, _) in THIRD_PARTY.items() if SCRIPT_SRC in uses}
FORM_ACTION_ALLOWED = {url for url, (uses, _) in THIRD_PARTY.items() if FORM_ACTION in uses}
INLINE_SCRIPT_URLS = {url for url, (uses, _) in THIRD_PARTY.items() if INLINE_SCRIPT in uses}

# The fallback contact, in the served HTML so a blocked script or an
# unreachable server cannot hide it.
CONTACT_EMAIL = "aaron@crimsoncowlabs.com"

# Where the firm's server sends a native (no-JS) form POST back to, with a 303:
# PAGE_URL plus one of these fragments, never a query string. Both are
# elements in #contact's served HTML that CSS :target reveals, so the reader
# gets a confirmation without the script. The server (in
# CrimsonCowLabs/marketing-site) and this list change together.
CONTACT_OUTCOME_IDS = ("contact-sent", "contact-error")

# The server's own field limits, mirrored as maxlength so a browser stops the
# reader at the limit rather than the server rejecting the whole message.
# Change them with the server's.
CONTACT_MAXLENGTH = {"name": 200, "email": 320, "message": 5000}

# What the author still has to supply before the page can ship (#38). The
# markup marks each placeholder with data-placeholder; the beacon's token (in
# its data-cf-beacon) is this literal until Cloudflare issues the real one.
BEACON_TOKEN_PLACEHOLDER = "CF_BEACON_TOKEN_TODO"

# Honeypot field: hidden from people, filled in by bots. It is exempt from the
# label requirement because nobody is meant to see it.
HONEYPOT = "website"
CONTACT_FIELDS = ("name", "email", "message", HONEYPOT)

# Off-origin on an <a> is a link, which is the point. Off-origin anywhere else
# is a runtime dependency: the page stops rendering when that host does — or,
# for a form's action, stops working — unless THIRD_PARTY names it.
URL_ATTRS = {"src", "href", "srcset", "data", "poster", "action", "formaction"}
# Elements read whole — all their descendant text, links and ids — by id. The
# navbar is one more region, found by its class: it is what "reachable from
# the top" means.
REGIONS = ("commercial-support", "consulting", "contact", "measurement")
NAVBAR = "navbar"

# An absolute URL in the inline script, or a protocol-relative //host one,
# which is just as off-origin. The host has to look like one (a dot in it), so
# a `//` comment is not mistaken for a URL.
INLINE_URL = re.compile(r"""(?:\bhttps?:)?//[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`<>()\\]*""", re.I)
PRICE = re.compile(r"\$\s?\d")
AUTHORED = re.compile(r"\b(?:wrote|written|built|authored|maintains?|maintained)\b", re.I)
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
        self.scripts = []          # {"src", "type", "text"}, one per <script>
        self.inline_handlers = []  # (tag, attr) for every on*= attribute
        self.off_origin = []       # (tag, attr, value) outside <a>
        self.links = []            # every <a href>
        self.link_tags = []        # attributes of every <link>
        self.html_attrs = {}
        self.pre_text = ""         # raw text inside <pre>, newlines intact
        self.text = []             # (tag, classes, normalised text)
        self.ids = []              # every id= attribute, in document order
        self.faq_items = []        # {"id", "questions", "answers"}, one per .faq-item
        self.stray_faq = []        # .faq-q/.faq-a text found outside any .faq-item
        self.regions = {kind: [] for kind in (*REGIONS, NAVBAR)}  # {"text", "links", "ids"} each
        self.engagements = []      # {"names", "prices", "placeholder"}, one per .engagement
        self.placeholders = []     # a description of every element with data-placeholder
        self.beacons = []          # the self.scripts entries whose src is SCRIPT_SRC_ALLOWED
        self.forms = []            # {"id", "method", "action", "in_contact"}, one per <form>
        self.fields = []           # {"tag", "name", "type", "id", "required", "maxlength",
                                   #  "labelled", "form"}
        self.label_for = set()     # every <label for=...>
        self._stack = []
        self._form = None          # the self.forms entry currently open
        self._heading = None       # (tag, classes, [text so far]) while inside h1-h6
        self._script = None        # the self.scripts entry whose text is being read
        self._captures = []        # elements whose whole descendant text is wanted

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
            # A missing type and an empty one mean the same thing; MIME types
            # are case-insensitive. Its text is read in handle_data.
            self._script = {
                "src": (attrs.get("src") or "").strip(),
                "type": (attrs.get("type") or "").strip().lower(),
                "text": "",
                # Boolean attributes parse to None, so presence is the test.
                "deferred": "defer" in attrs or "async" in attrs,
            }
            self.scripts.append(self._script)
            if self._script["src"] in SCRIPT_SRC_ALLOWED:
                # The beacon's configuration, parsed here once for every check
                # that needs the token: "token" is None if there is none,
                # "config_error" says the attribute was not a JSON object.
                config = attrs.get("data-cf-beacon")
                try:
                    token = json.loads(config or "").get("token")
                    config_error = False
                except (json.JSONDecodeError, AttributeError):
                    token, config_error = None, True
                self.beacons.append({"script": self._script, "config": config,
                                     "token": token, "config_error": config_error})
        elif tag == "a":
            self.links.append(attrs.get("href", ""))
            for capture in self._captures:
                capture["links"].append(attrs.get("href", ""))
        elif tag == "link":
            self.link_tags.append(attrs)
        elif tag == "label" and attrs.get("for"):
            self.label_for.add(attrs["for"])
        elif tag == "form":
            self._form = {
                "id": attrs.get("id"),
                "method": (attrs.get("method") or "get").strip().lower(),
                "action": (attrs.get("action") or "").strip(),
                "in_contact": self._inside("contact"),
            }
            self.forms.append(self._form)
        elif tag in ("input", "textarea", "select"):
            self.fields.append({
                "tag": tag,
                "name": attrs.get("name"),
                "type": (attrs.get("type") or "").strip().lower(),
                "id": attrs.get("id"),
                "required": "required" in attrs,
                "maxlength": (attrs.get("maxlength") or "").strip(),
                "labelled": any(open_tag == "label" for open_tag, _ in self._stack),
                "form": self._form["id"] if self._form else None,
            })
        for attr, value in attrs.items():
            if attr.startswith("on"):
                self.inline_handlers.append((tag, attr))
            # A <script src> is held to THIRD_PARTY in full below, on-origin
            # included, so it is excluded here rather than reported twice
            # under a message that only makes sense for an off-origin one. A <link rel=canonical>
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
        if attrs.get("id"):
            self.ids.append(attrs["id"])
            for capture in self._captures:
                capture["ids"].append(attrs["id"])
        if _is_heading(tag):
            # A heading cannot contain another; a browser closes the open one
            # first, and so does this.
            self._close_heading()
            self._heading = (tag, classes, [])
        # The FAQ and the support statement are read the way headings are —
        # all of an element's descendant text, joined as it renders, so an
        # answer with a <code> or a link in it is one answer, not three
        # fragments — and recorded when the element closes. The depth is the
        # stack height the element opened at, so its close is recognised by
        # the stack dropping back to it.
        kind = None
        item = None
        if "faq-item" in classes:
            kind = "faq-item"
            item = {"id": attrs.get("data-faq"), "questions": [], "answers": []}
            self.faq_items.append(item)
        elif tag == "p" and "faq-a" in classes:
            kind = "faq-a"
        elif "engagement" in classes:
            kind = "engagement"
            item = {"names": [], "prices": [], "placeholder": "data-placeholder" in attrs}
            self.engagements.append(item)
        elif "engagement-price" in classes:
            kind = "engagement-price"
        elif attrs.get("id") in REGIONS:
            kind = attrs["id"]
        elif tag == "header" and "navbar" in classes:
            kind = NAVBAR
        if kind:
            self._captures.append({"kind": kind, "depth": len(self._stack), "parts": [],
                                   "links": [], "ids": [], "item": item})
        if "data-placeholder" in attrs:
            if attrs.get("id"):
                where = f'<{tag} id="{attrs["id"]}">'
            elif attrs.get("class"):
                where = f'<{tag} class="{attrs["class"]}">'
            else:
                where = f"<{tag}>"
            # An engagement is also named by its position (1-based), so three
            # unfilled ones are three distinguishable failures.
            if kind == "engagement":
                where = f"engagement {len(self.engagements)} {where}"
            self.placeholders.append(where)
        self._stack.append((tag, classes))

    def handle_endtag(self, tag):
        if tag == "script":
            self._script = None
        elif tag == "form":
            self._form = None
        while self._stack:
            if self._stack.pop()[0] == tag:
                break
        # Any </h1>-</h6> closes the open heading, as it does in a browser, so
        # a mismatched close tag cannot swallow the rest of the page into it.
        if _is_heading(tag):
            self._close_heading()
        while self._captures and len(self._stack) <= self._captures[-1]["depth"]:
            capture = self._captures[-1]
            if capture["kind"] in ("faq-item", "engagement"):
                # A question left open by a missing </h3> still belongs to
                # the item it was written in, not to whatever comes next.
                self._close_heading()
            self._close_capture(self._captures.pop())

    def _close_heading(self):
        if self._heading is None:
            return
        heading_tag, classes, parts = self._heading
        self._heading = None
        text = " ".join("".join(parts).split())
        if text:
            self.text.append((heading_tag, classes, text))
        if "faq-q" in classes:
            self._faq_add("questions", text)
        engagement = self._innermost("engagement")
        if heading_tag == "h3" and engagement is not None:
            engagement["names"].append(text)

    def _close_capture(self, capture):
        text = " ".join("".join(capture["parts"]).split())
        if capture["kind"] == "faq-a":
            self._faq_add("answers", text)
        elif capture["kind"] == "engagement-price":
            engagement = self._innermost("engagement")
            if engagement is not None:
                engagement["prices"].append(text)
        elif capture["kind"] in self.regions:
            self.regions[capture["kind"]].append(
                {"text": text, "links": capture["links"], "ids": capture["ids"]})

    def _innermost(self, kind):
        """The item of the innermost open capture of this kind, or None."""
        for capture in reversed(self._captures):
            if capture["kind"] == kind:
                return capture["item"]
        return None

    def _inside(self, kind):
        return any(capture["kind"] == kind for capture in self._captures)

    def _faq_add(self, field, text):
        item = self._innermost("faq-item")
        if item is None:
            self.stray_faq.append(text)
        else:
            item[field].append(text)

    def handle_data(self, data):
        if self._script is not None:
            # Script text is code or JSON, never prose: kept on the script it
            # belongs to and out of self.text, so no check that reads the
            # page's words can find them inside a <script> instead.
            self._script["text"] += data
            return
        if not self._stack:
            return
        for capture in self._captures:
            capture["parts"].append(data)
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

    def visible_text(self):
        """All the page's words a reader sees, as one normalised string.

        <title> and <style> are text to the parser but not to a reader;
        <script> content never reaches self.text at all.
        """
        return " ".join(
            text for element, _classes, text in self.text
            if element not in ("title", "style")
        )

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
        elif path.suffix.lower() == ".txt" and path.relative_to(site).as_posix() != LLMS_TXT:
            # .txt was admitted for site/llms.txt alone (#37). Anything else is
            # either a misplaced copy of it or a file nothing links to.
            fail(f"{path.relative_to(site)}: the only .txt file the page may ship is "
                 f"{LLMS_TXT}, at the top of the site")
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

    for script in page.scripts:
        if script["type"] not in SCRIPT_TYPES:
            fail(f'<script type="{script["type"]}">: the only script types allowed are an inline '
                 f"classic script and {JSON_LD} structured data")
    for tag, attr in page.inline_handlers:
        fail(f"<{tag} {attr}>: inline event handler is still JavaScript")
    check_third_party(page)


def check_third_party(page):
    """The page touches no off-origin URL that THIRD_PARTY does not name.

    This is where #38's allowance is enforced, and where its limits are. A
    <script src> is still rejected unless it is exactly the Cloudflare beacon,
    local paths included, and there may be one beacon. It has to be `defer` or
    `async`: a classic script without either blocks parsing until its host
    answers, and a blocked or unreachable tracker must not cost the page its
    rendering. Every other off-origin resource — a stylesheet, a font, an
    image, a preconnect — is a render dependency on a host this page does not
    control and fails as it always has, so nothing third-party can block
    rendering. A form may post off-origin only to the contact endpoint. The
    inline classic script is held to the same list: any http(s) URL in it
    must be one THIRD_PARTY allows there, protocol-relative //host ones
    included. (Before #38 it contained none.)
    """
    for script in page.scripts:
        if script["src"] and script["src"] not in SCRIPT_SRC_ALLOWED:
            fail(f'<script src="{script["src"]}">: the only script that may load from anywhere, '
                 f"this origin included, is the Cloudflare Web Analytics beacon {BEACON_URL} "
                 "(#38); every other script is inline")
    for beacon in page.beacons:
        if not beacon["script"]["deferred"]:
            fail(f'<script src="{beacon["script"]["src"]}"> has neither defer nor async, so it '
                 "blocks rendering until Cloudflare answers: a blocked tracker must not hold up "
                 "the page (#38)")
    if len(page.beacons) > 1:
        fail(f"{len(page.beacons)} copies of the Cloudflare beacon: it counts each pageview "
             "once per copy")

    for tag, attr, value in page.off_origin:
        if tag == "form" and attr == "action" and value in FORM_ACTION_ALLOWED:
            continue
        fail(f"<{tag} {attr}=\"{value}\">: off-origin runtime dependency not named in THIRD_PARTY")

    for script in page.scripts:
        if script["src"] or script["type"] not in CLASSIC_SCRIPT_TYPES:
            continue
        for url in INLINE_URL.findall(script["text"]):
            if url not in INLINE_SCRIPT_URLS:
                fail(f"the inline script talks to {url!r}, which THIRD_PARTY does not allow it: "
                     f"only {sorted(INLINE_SCRIPT_URLS)} (#38)")


def check_placeholders(page):
    """Nothing the author has yet to supply is still a placeholder.

    #38's engagement names and starting prices are business decisions, and
    the beacon token is issued by Cloudflare; none of them may be invented.
    Until they are supplied the page carries marked placeholders, and this
    fails — on purpose, so CI is red until the author fills them in rather
    than a page with "From $TODO" on it shipping by accident.
    """
    for where in page.placeholders:
        fail(f"{where} is marked data-placeholder: engagement names and starting prices must "
             "come from the author (#38)")
    if any(beacon["token"] == BEACON_TOKEN_PLACEHOLDER for beacon in page.beacons):
        fail(f"the beacon's token is still {BEACON_TOKEN_PLACEHOLDER}: the Cloudflare Web "
             "Analytics token must come from the author's Cloudflare account (#38)")
    # #contact too: its engagement <select> repeats the engagement names.
    for kind in ("consulting", "contact"):
        for region in page.regions[kind]:
            if re.search(r"\bTODO\b", region["text"]):
                fail(f"#{kind} still says TODO: engagement names and starting prices must come "
                     "from the author (#38)")


def check_consulting(page):
    """The firm, why it is credible here, and named engagements with a starting price.

    Credibility is the one fact the page can prove: CrimsonCow Labs wrote the
    template the reader is about to use. The test for that is deliberately
    loose about wording — the firm's name, and a sentence with the word
    "template" and a verb of authorship in it — so the copy can be rewritten without editing this. Each
    engagement needs a name and a price signal, a dollar amount, so an enquiry
    arrives already knowing roughly what it costs.
    """
    regions = page.regions["consulting"]
    if len(regions) != 1:
        fail(f'expected exactly one element with id="consulting", found {len(regions)}')
    else:
        text = regions[0]["text"]
        if ORG_NAME not in text:
            fail(f"#consulting does not name {ORG_NAME!r}")
        # In one sentence, so "products built on it" next to an unrelated
        # mention of the template does not pass for a claim of authorship.
        sentences = re.split(r"(?<=[.!?])\s+", text)
        if not any("template" in s.lower() and AUTHORED.search(s) for s in sentences):
            fail(f"#consulting does not say {ORG_NAME} wrote or maintains this template, "
                 "which is the reason a reader should trust it here")
    if not page.engagements:
        fail('no .engagement elements: #38 asks for named engagements with a starting price')
    for number, engagement in enumerate(page.engagements, 1):
        if engagement["placeholder"]:
            continue  # already failed in check_placeholders, which says what to supply
        names = [name for name in engagement["names"] if name]
        label = f".engagement {names[0]!r}" if names else f".engagement #{number}"
        if len(names) != 1:
            fail(f"{label}: expected exactly one non-empty <h3> naming it, found {len(names)}")
        if not any(PRICE.search(price) for price in engagement["prices"]):
            fail(f'{label}: no .engagement-price with a starting amount in dollars '
                 f'(found {engagement["prices"]})')


def check_contact(page):
    """A contact form that works, labelled, with a fallback that needs neither it nor the script.

    The form posts natively, so it works with JavaScript off; the script only
    upgrades it. If the firm's server is unreachable, the mailto link is still
    there — in the served HTML, which is what this reads, so it cannot be one
    the script inserts on failure. A native submit comes back to
    CONTACT_OUTCOME_IDS, which have to be in #contact for :target to show the
    reader what happened. And the contact section is linked from the
    navbar, so it is reachable from the top without scrolling the page.

    Which server the form may post to is check_third_party's business; this
    only requires that it posts to one at all, since Pages cannot take a POST.
    """
    regions = page.regions["contact"]
    if len(regions) != 1:
        fail(f'expected exactly one element with id="contact", found {len(regions)}')
        return
    forms = [form for form in page.forms if form["id"] == "contact-form"]
    if len(forms) != 1:
        fail(f'expected exactly one <form id="contact-form">, found {len(forms)}')
    else:
        form = forms[0]
        if not form["in_contact"]:
            fail('<form id="contact-form"> is not inside #contact')
        if form["method"] != "post":
            fail(f'<form id="contact-form"> has method {form["method"]!r}, not post')
        if not OFF_ORIGIN.match(form["action"]):
            fail(f'<form id="contact-form"> posts to {form["action"]!r}, which is GitHub Pages: '
                 "it cannot receive a POST, so the form only works with the script")

        fields = [field for field in page.fields if field["form"] == "contact-form"]
        names = {field["name"] for field in fields}
        for required in CONTACT_FIELDS:
            if required not in names:
                what = "honeypot field" if required == HONEYPOT else "field"
                fail(f'the contact form has no {what} named {required!r}')
        for field in fields:
            if field["name"] == HONEYPOT or field["type"] in ("hidden", "submit", "button", "reset", "image"):
                continue
            if not field["labelled"] and field["id"] not in page.label_for:
                fail(f'contact form <{field["tag"]} name="{field["name"]}"> has no <label>: '
                     "wrap it in one or point one at its id with for=")
        for field in fields:
            limit = CONTACT_MAXLENGTH.get(field["name"])
            if limit is not None and field["maxlength"] != str(limit):
                fail(f'contact form <{field["tag"]} name="{field["name"]}"> has maxlength '
                     f'{field["maxlength"] or "unset"}, not the server\'s limit of {limit}')
            if field["name"] == "email":
                if field["type"] != "email":
                    fail(f'the contact form\'s email field is type {field["type"]!r}, not "email"')
                if not field["required"]:
                    fail("the contact form's email field is not required")

    mailto = f"mailto:{CONTACT_EMAIL}"
    if not any(href.split("?")[0] == mailto for href in regions[0]["links"]):
        fail(f'no <a href="{mailto}"> in the served HTML of #contact: if the form\'s server is '
             "unreachable or the script is blocked, the reader has no other way to reach out")

    for outcome in CONTACT_OUTCOME_IDS:
        if outcome not in regions[0]["ids"]:
            fail(f'no id="{outcome}" in #contact: the server sends a no-JS submit back to '
                 f"{PAGE_URL}#{outcome}, and without it the reader is not told what happened")

    navbar = page.regions[NAVBAR]
    if not any(href in ("#contact", PAGE_URL + "#contact") for region in navbar for href in region["links"]):
        fail('no link to #contact in <header class="navbar">: the contact path has to be '
             "reachable from the top of the page")


def check_measurement(page):
    """The page says what it measures, and the beacon it says it uses is there and configured.

    #38 asks for measurement that sets no cookies and collects no personal
    data, and for the page to say so; this audience notices tracking, so the
    disclosure names the provider and the absence of cookies outright.
    """
    regions = page.regions["measurement"]
    if len(regions) != 1:
        fail(f'expected exactly one element with id="measurement", found {len(regions)}: '
             "the page has to say what it measures")
    else:
        text = regions[0]["text"]
        if "cookie" not in text.lower():
            fail(f"#measurement does not say anything about cookies: {text!r}")
        if "Cloudflare" not in text:
            fail(f"#measurement does not name Cloudflare Web Analytics: {text!r}")

    if not page.beacons:
        fail(f'no <script src="{BEACON_URL}">: pageviews are not measured')
        return
    beacon = page.beacons[0]
    if beacon["config_error"]:
        fail(f"the beacon's data-cf-beacon is not a JSON object: {beacon['config']!r}")
    elif not isinstance(beacon["token"], str) or not beacon["token"].strip():
        fail(f"the beacon's data-cf-beacon has no token: {beacon['config']!r}")


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


def _types(node):
    """A JSON-LD node's @type as a set, whether it was written as one or a list."""
    value = node.get("@type", [])
    return set(value) if isinstance(value, list) else {value}


def _nodes(value):
    """Every JSON object in a JSON-LD document that has an @type, at any depth.

    Walking the whole tree rather than only the top level (or @graph) means a
    node counts the same whether it is written once and referenced by @id or
    written inline where it is used — an author given inline is still the
    one Organization, not a second one hiding inside the first.
    """
    if isinstance(value, dict):
        if "@type" in value:
            yield value
        for child in value.values():
            yield from _nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _nodes(child)


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _normalise(text):
    return " ".join(str(text).split())


def _one(nodes, schema_type):
    """The single node of this type, failing (and returning None) unless there is exactly one."""
    found = [node for node in nodes if schema_type in _types(node)]
    if len(found) != 1:
        fail(f"structured data: expected exactly one {schema_type}, found {len(found)}")
        return None
    return found[0]


def check_faq(page):
    """The visible FAQ is well-formed and asks the questions #37 requires.

    This is the human-readable half of the FAQ, and the one that matters:
    check_structured_data then requires the FAQPage to repeat it exactly, so
    the copy is written once, here, in the HTML a person and a no-JS crawler
    both read.
    """
    if "faq" not in page.ids:
        fail('no element with id="faq": the FAQ section is missing')
    if not page.faq_items:
        fail('no .faq-item elements: the page has no FAQ to quote')
        return []
    for text in page.stray_faq:
        fail(f".faq-q/.faq-a {text!r} is outside any .faq-item, so it belongs to no question")

    seen = set()
    for index, item in enumerate(page.faq_items, 1):
        label = f'.faq-item data-faq="{item["id"]}"' if item["id"] else f".faq-item #{index}"
        if not item["id"]:
            fail(f"{label} has no data-faq id, so nothing can tell which question it answers")
        elif item["id"] in seen:
            fail(f'{label} appears more than once')
        seen.add(item["id"])
        if len(item["questions"]) != 1 or not item["questions"][0]:
            fail(f'{label}: expected exactly one non-empty <h3 class="faq-q">, '
                 f'found {len(item["questions"])}')
        if len(item["answers"]) != 1 or not item["answers"][0]:
            fail(f'{label}: expected exactly one non-empty <p class="faq-a">, '
                 f'found {len(item["answers"])}')

    for required in REQUIRED_FAQ_IDS:
        if required not in seen:
            fail(f'the FAQ has no data-faq="{required}" item: #37 requires that question answered')

    return [
        (item["questions"][0], item["answers"][0])
        for item in page.faq_items
        if len(item["questions"]) == 1 and len(item["answers"]) == 1
    ]


def check_structured_data(page, faq):
    """The JSON-LD says what the project is, who maintains it, and what the FAQ says — truthfully.

    An assistant that recommends this page repeats whatever the structured data
    claims, so every value checked against a constant here is one that has to
    stay true of the template, not one that merely has to be present. The
    FAQPage is held to the visible FAQ question for question and answer for
    answer (whitespace aside), in order: Google requires FAQ markup to match
    what the page shows, and it is the same single-source-of-truth rule as
    og:title repeating <title> — the copy lives in the HTML, and the data
    repeats it rather than drifting into its own version.
    """
    blocks = [script for script in page.scripts if script["type"] == JSON_LD]
    if not blocks:
        fail(f'no <script type="{JSON_LD}">: the page carries no structured data')
        return

    nodes = []
    for number, block in enumerate(blocks, 1):
        try:
            document = json.loads(block["text"])
        except json.JSONDecodeError as error:
            fail(f"structured data block {number} is not valid JSON: {error}")
            continue
        for top in _as_list(document):
            context = top.get("@context") if isinstance(top, dict) else None
            if context != SCHEMA_ORG:
                fail(f"structured data block {number}: @context is {context!r}, "
                     f"not {SCHEMA_ORG!r}")
        nodes.extend(_nodes(document))
    if not nodes:
        return

    org = _one(nodes, "Organization")
    if org is not None:
        if org.get("name") != ORG_NAME:
            fail(f"structured data: Organization name is {org.get('name')!r}, not {ORG_NAME!r}")
        if str(org.get("url", "")).rstrip("/") != ORG_URL:
            fail(f"structured data: Organization url is {org.get('url')!r}, not {ORG_URL!r}")
        if ORG_GITHUB not in [str(u).rstrip("/") for u in _as_list(org.get("sameAs"))]:
            fail(f"structured data: Organization sameAs does not include {ORG_GITHUB!r}")

    code = _one(nodes, "SoftwareSourceCode")
    if code is not None:
        expected = {
            "name": PROJECT_NAME,
            "codeRepository": REPO_URL,
            "url": PAGE_URL,
            "license": LICENSE_URL,
        }
        for key, value in expected.items():
            if code.get(key) != value:
                fail(f"structured data: SoftwareSourceCode {key} is {code.get(key)!r}, not {value!r}")
        if not _as_list(code.get("programmingLanguage")):
            fail("structured data: SoftwareSourceCode has no programmingLanguage")
        # The maintainer is the Organization, given inline or referenced by
        # its @id — either way it has to resolve to the one checked above.
        people = _as_list(code.get("author")) + _as_list(code.get("maintainer"))
        if org is not None and not any(
            isinstance(who, dict)
            and (who is org or (who.get("@id") and who.get("@id") == org.get("@id")))
            for who in people
        ):
            fail("structured data: SoftwareSourceCode has no author or maintainer that is "
                 f"the {ORG_NAME} Organization (inline, or by its @id)")

    faq_page = _one(nodes, "FAQPage")
    if faq_page is None:
        return
    entities = _as_list(faq_page.get("mainEntity"))
    data_faq = []
    for number, question in enumerate(entities, 1):
        answer = question.get("acceptedAnswer") if isinstance(question, dict) else None
        if (
            not isinstance(question, dict)
            or "Question" not in _types(question)
            or not question.get("name")
            or not isinstance(answer, dict)
            or "Answer" not in _types(answer)
            or not answer.get("text")
        ):
            fail(f"structured data: FAQPage mainEntity {number} is not a Question with a name "
                 "and an acceptedAnswer of @type Answer with text")
            # Comparing the rest with the page would only repeat this failure
            # as a list of every question, misaligned by one.
            return
        data_faq.append((_normalise(question["name"]), _normalise(answer["text"])))

    visible = [(_normalise(q), _normalise(a)) for q, a in faq]
    if [q for q, _ in data_faq] != [q for q, _ in visible]:
        fail("structured data: FAQPage questions do not match the visible FAQ, in order: "
             f"data has {[q for q, _ in data_faq]}, page has {[q for q, _ in visible]}")
        return
    for (question, data_answer), (_, page_answer) in zip(data_faq, visible):
        if data_answer != page_answer:
            fail(f"structured data: FAQPage answer to {question!r} does not match the visible "
                 f"answer: data says {data_answer!r}, page says {page_answer!r}")


def check_licence(page):
    """The licence is stated where a reader sees it, and it is the one the repo carries.

    The structured data's licence is checked against LICENSE_URL above; this
    is the visible half, plus the file both of them are claims about.
    """
    if not (ROOT / "LICENSE").read_text().startswith("MIT License"):
        fail(f"{ROOT / 'LICENSE'} is not the MIT licence the page and structured data claim")
    if not re.search(r"\bMIT\b", page.visible_text()):
        fail("the page never says it is MIT licensed")
    if LICENSE_FILE_URL not in page.links:
        fail(f"no link to the licence file at {LICENSE_FILE_URL}")


def check_commercial_support(page):
    """One quotable statement that commercial support exists, and who from.

    It is an element with a fixed id rather than a phrase somewhere in the
    copy, so there is exactly one sentence for an assistant to lift and for
    this check to hold to: it names the firm the way a person reads it and
    links to where to reach it.
    """
    statements = page.regions["commercial-support"]
    if len(statements) != 1:
        fail(f'expected exactly one element with id="commercial-support", found {len(statements)}')
        return
    statement = statements[0]
    if ORG_NAME not in statement["text"]:
        fail(f"the commercial support statement does not name {ORG_NAME!r}: {statement['text']!r}")
    if "support" not in statement["text"].lower():
        fail(f"the commercial support statement does not mention support: {statement['text']!r}")
    if not any(href.rstrip("/") == ORG_URL for href in statement["links"]):
        fail(f"the commercial support statement does not link to {ORG_URL}")


def check_content_without_javascript(page):
    """The FAQ, support statement and structured data are not built by the script.

    The checks above already read the served HTML, which is what a crawler
    that does not run JavaScript gets, so finding that content there proves
    it is present with scripts off. This only closes the obvious way to
    break that later: the inline script growing code that assembles any of
    it, which would be a second copy for the HTML one to drift from.
    """
    for script in page.scripts:
        if script["type"] not in CLASSIC_SCRIPT_TYPES:
            continue
        for marker in SCRIPT_MUST_NOT_BUILD:
            if marker in script["text"].lower():
                fail(f"the inline script mentions {marker!r}: FAQ, support and structured data "
                     "content belongs in the served HTML, not built at runtime")


def check_llms_txt(page, site):
    """site/llms.txt exists, follows the llms.txt shape, says the essentials, and is linked.

    The llms.txt convention puts the file at the host root, which on a project
    Pages site belongs to another repo; this one lands at
    PAGE_URL + "llms.txt" instead, where a crawler probing /llms.txt will not
    find it. The link from the page is what makes it reachable at all — a
    crawler that follows links gets there — so the link is checked as
    strictly as the file.
    """
    path = site / LLMS_TXT
    if not path.is_file():
        fail(f"no such file: {path}")
    else:
        try:
            content = path.read_bytes().decode("utf-8")
        except UnicodeDecodeError as error:
            fail(f"{path}: not UTF-8 text: {error}")
            content = None
        if content is not None:
            lines = [line.strip() for line in content.splitlines()]
            if not lines or not lines[0].startswith("# ") or PROJECT_NAME not in lines[0]:
                fail(f"{path}: the first line must be a '# ' heading naming {PROJECT_NAME}")
            rest = [line for line in lines[1:] if line]
            if not rest or not rest[0].startswith("> "):
                fail(f"{path}: the heading must be followed by a '> ' one-paragraph summary")
            if INSTALL_COMMAND not in content:
                fail(f"{path} does not contain the install command {INSTALL_COMMAND!r}")
            if REPO_URL not in content:
                fail(f"{path} does not link to the repo at {REPO_URL}")
            if not re.search(r"\bMIT\b", content):
                fail(f"{path} does not state the MIT licence")

    if not any(href in (LLMS_TXT, PAGE_URL + LLMS_TXT) for href in page.links):
        fail(f"the page does not link to {LLMS_TXT}: on a subpath, nothing finds it by convention")


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
        faq = check_faq(page)
        check_structured_data(page, faq)
        check_licence(page)
        check_commercial_support(page)
        check_content_without_javascript(page)
        check_llms_txt(page, site)
        check_placeholders(page)
        check_consulting(page)
        check_contact(page)
        check_measurement(page)

    for message in failures:
        print(f"FAIL: {message}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print(f"ok: {site} is a static landing page with a copyable install command, "
          f"structured data that matches its FAQ, a linked {LLMS_TXT}, priced engagements, "
          f"a contact form with a mailto fallback, disclosed cookieless measurement and "
          f"no third party beyond THIRD_PARTY, {indexing}")


if __name__ == "__main__":
    main()
