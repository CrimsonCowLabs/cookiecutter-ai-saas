"""Fetch a public web page and extract its title and readable text.

This is the worker's one real tool: it needs no API key and no external
service, so a freshly generated project does something visible on the first
job. The URL comes from an end user, and the worker sits on a Docker network
with Postgres and Redis, so every request is treated as hostile input:

- http/https only.
- The host is resolved and the request is refused if *any* resolved address is
  loopback, private, link-local, reserved, multicast or otherwise non-public.
- Redirects are followed by hand, at most `MAX_REDIRECTS` hops, re-validating
  every hop. (Letting urllib follow them is the usual SSRF bypass: only the
  first URL gets checked.)
- Hard timeout, and a response-size cap enforced while reading rather than
  after, so a never-ending body cannot exhaust memory.
- Only text-ish content types are accepted.

The extracted text is truncated to a character budget so a huge page cannot
blow up the model prompt; `PageContent.truncated` says whether that happened.

Every rejection and failure raises `FetchError`, so callers catch one thing.

Known limit: validation resolves the host, then urllib resolves it again to
connect, so a DNS record that changes between the two (rebinding) is not
caught. Pinning the socket to the validated address needs a custom opener; the
guard here is the cheap 95% of it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from langchain_core.tools import StructuredTool

logger = logging.getLogger("tools.fetch_url")

TIMEOUT_SECONDS = 15.0
MAX_REDIRECTS = 3
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 8_000
_READ_CHUNK_BYTES = 64 * 1024

ALLOWED_CONTENT_TYPES = frozenset(
    {"text/html", "text/plain", "application/json", "application/xhtml+xml"}
)
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_USER_AGENT = "__PROJECT_SLUG__-worker (+fetch_url tool)"


class FetchError(Exception):
    """Every way `fetch_page` can refuse or fail. Catch this to end cleanly."""


@dataclass(frozen=True)
class RawResponse:
    """A fetched body, before any extraction. What the injectable fetcher returns."""

    url: str
    content_type: str
    body: str


@dataclass(frozen=True)
class PageContent:
    """Extracted, bounded page content."""

    url: str
    title: str
    text: str
    chars: int
    truncated: bool
    content_type: str

    def as_dict(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "text": self.text,
            "chars": self.chars,
            "truncated": self.truncated,
            "content_type": self.content_type,
        }


Fetcher = Callable[[str], RawResponse]
Resolver = Callable[..., list]


# --------------------------------------------------------------------------
# SSRF guard
# --------------------------------------------------------------------------


def _classify_address(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Name the reason `ip` is off limits, or None if it is a public address.

    Ordered most specific first: `is_private` is true for loopback and
    link-local too, and the specific name makes the rejection legible.
    """
    if ip.is_unspecified:
        return "unspecified"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local"
    if ip.is_multicast:
        return "multicast"
    if ip.is_reserved:
        return "reserved"
    if ip.is_private:
        return "private"
    if not ip.is_global:
        return "non-public"
    return None


def validate_url(url: str, *, resolve: Resolver = socket.getaddrinfo) -> str:
    """Return `url` unchanged, or raise `FetchError` saying why it is refused."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError(
            f"only http and https URLs are allowed, got {parts.scheme or '(none)'!r}"
        )

    host = parts.hostname
    if not host:
        raise FetchError(f"URL has no host: {url!r}")

    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = resolve(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise FetchError(f"could not resolve host {host!r}: {exc}") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise FetchError(f"host {host!r} resolved to no addresses")

    for address in sorted(addresses):
        try:
            # Strip any IPv6 scope id ("fe80::1%eth0") before parsing.
            ip = ipaddress.ip_address(address.split("%")[0])
        except ValueError as exc:
            raise FetchError(f"host {host!r} resolved to an unparseable address {address!r}") from exc
        blocked = _classify_address(ip)
        if blocked:
            raise FetchError(
                f"refusing to fetch {host!r}: it resolves to a {blocked} address ({ip})"
            )
    return url


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class _NoRedirect(HTTPRedirectHandler):
    """Redirect handler that refuses to redirect, so this module can do it itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


# Passing an HTTPRedirectHandler subclass replaces urllib's default one.
_opener = build_opener(_NoRedirect)


def _open(request: Request, timeout: float) -> Any:
    """Open `request` without following redirects; a 3xx comes back as a response."""
    try:
        return _opener.open(request, timeout=timeout)
    except HTTPError as exc:
        # With redirects disabled urllib raises for 3xx as well; HTTPError is
        # itself a response object, so hand it back for uniform handling.
        return exc


def _header(response: Any, name: str) -> str:
    return (response.headers.get(name) or "") if response.headers is not None else ""


def _read_capped(response: Any, limit: int) -> bytes:
    """Read at most `limit` bytes, failing as soon as the body goes over."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise FetchError(f"response body exceeded the {limit} byte limit")
        chunks.append(chunk)
    return b"".join(chunks)


def http_get(
    url: str,
    *,
    timeout: float = TIMEOUT_SECONDS,
    max_bytes: int = MAX_RESPONSE_BYTES,
    opener: Callable[[Request, float], Any] = _open,
    resolve: Resolver = socket.getaddrinfo,
) -> RawResponse:
    """Fetch `url`, following redirects by hand and validating every hop.

    Blocking. `fetch_page` runs it on a worker thread.
    """
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        validate_url(current, resolve=resolve)
        request = Request(
            current,
            method="GET",
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain,application/json",
                "Accept-Encoding": "identity",
            },
        )
        try:
            response = opener(request, timeout)
        except URLError as exc:
            raise FetchError(f"request to {current!r} failed: {exc.reason}") from exc
        except (TimeoutError, OSError) as exc:
            raise FetchError(f"request to {current!r} failed: {exc}") from exc

        try:
            status = int(getattr(response, "status", None) or 0)

            if status in _REDIRECT_CODES:
                location = _header(response, "Location")
                if not location:
                    raise FetchError(f"{current!r} returned HTTP {status} with no Location header")
                if hop == MAX_REDIRECTS:
                    raise FetchError(f"more than {MAX_REDIRECTS} redirects starting at {url!r}")
                current = urljoin(current, location)
                continue

            if status >= 400 or status < 200:
                raise FetchError(f"{current!r} returned HTTP {status}")

            content_type = _header(response, "Content-Type")
            media_type = content_type.split(";")[0].strip().lower()
            if media_type not in ALLOWED_CONTENT_TYPES:
                raise FetchError(
                    f"{current!r} returned unsupported content type {media_type or '(none)'!r}; "
                    f"expected one of {', '.join(sorted(ALLOWED_CONTENT_TYPES))}"
                )

            raw = _read_capped(response, max_bytes)
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()

        charset = _charset(content_type)
        return RawResponse(url=current, content_type=media_type, body=raw.decode(charset, errors="replace"))

    raise FetchError(f"more than {MAX_REDIRECTS} redirects starting at {url!r}")


def _charset(content_type: str) -> str:
    for param in content_type.split(";")[1:]:
        key, _, value = param.partition("=")
        if key.strip().lower() == "charset":
            candidate = value.strip().strip('"').strip("'")
            if candidate:
                try:
                    "".encode(candidate)
                except LookupError:
                    return "utf-8"
                return candidate
    return "utf-8"


# --------------------------------------------------------------------------
# HTML extraction
# --------------------------------------------------------------------------

# Content inside these never reaches the model: it is markup, chrome or noise.
_SKIP_TAGS = frozenset(
    {"script", "style", "noscript", "template", "svg", "nav", "footer", "aside", "form"}
)
# Marks a block boundary while parsing. Not a newline: newlines inside the
# source text are just whitespace in HTML and must collapse to a space, so the
# breaks the parser inserts have to be distinguishable from them.
_BREAK = "\x00"

# Tags that end a block, so the extracted text keeps some structure.
_BREAK_TAGS = frozenset(
    {
        "p", "div", "br", "li", "tr", "section", "article", "blockquote", "pre",
        "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "dl", "dd", "dt",
        "header", "footer", "main", "figure", "figcaption", "hr",
    }
)


class _PageParser(HTMLParser):
    """Collects the document title and the readable text, skipping `_SKIP_TAGS`."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._title: list[str] = []
        self._text: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        if tag in _BREAK_TAGS:
            self._text.append(_BREAK)

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            # Guard against stray closing tags in malformed markup.
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "title":
            self._in_title = False
        if tag in _BREAK_TAGS:
            self._text.append(_BREAK)

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._in_title:
            self._title.append(data)
            return
        self._text.append(data)

    @property
    def title(self) -> str:
        return " ".join("".join(self._title).split())

    @property
    def text(self) -> str:
        return _join_blocks("".join(self._text))


def _join_blocks(raw: str) -> str:
    """One line per block: collapse whitespace within each, drop the empties."""
    blocks = (" ".join(block.split()) for block in raw.split(_BREAK))
    return "\n".join(block for block in blocks if block)


def _collapse_lines(raw: str) -> str:
    """Keep the line structure of already-plain text, collapsing runs of spaces."""
    lines = (" ".join(line.split()) for line in raw.splitlines())
    return "\n".join(line for line in lines if line)


def extract(response: RawResponse, *, max_chars: int = MAX_TEXT_CHARS) -> PageContent:
    """Turn a fetched body into bounded `PageContent`.

    HTML gets its title and readable text pulled out; other text types are
    passed through as-is with no title. The text is truncated to `max_chars`.
    """
    if response.content_type in ("text/html", "application/xhtml+xml"):
        parser = _PageParser()
        parser.feed(response.body)
        parser.close()
        title, text = parser.title, parser.text
    else:
        title, text = "", _collapse_lines(response.body)

    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars].rstrip()

    return PageContent(
        url=response.url,
        title=title,
        text=text,
        chars=len(text),
        truncated=truncated,
        content_type=response.content_type,
    )


# --------------------------------------------------------------------------
# Public entry point + tool
# --------------------------------------------------------------------------


async def fetch_page(
    url: str,
    *,
    fetcher: Fetcher | None = None,
    max_chars: int = MAX_TEXT_CHARS,
) -> PageContent:
    """Fetch `url` and return its extracted content.

    The network call is blocking, so it runs on a worker thread: BullMQ needs
    the event loop free to keep extending the job's lock.

    Args:
        url: The page to fetch. http/https only, public hosts only.
        fetcher: Blocking `str -> RawResponse` callable; defaults to `http_get`.
            Tests inject a fake so nothing touches the network.
        max_chars: Character budget for the extracted text.

    Raises:
        FetchError: the URL was refused, the request failed, or the response
            was too big, non-text or an HTTP error.
    """
    target = (url or "").strip()
    if not target:
        raise FetchError("no URL given")

    fetch = fetcher or http_get
    logger.info("Fetching %s", target)
    response = await asyncio.to_thread(fetch, target)
    page = extract(response, max_chars=max_chars)
    logger.info("Fetched %s (%d chars, truncated=%s)", page.url, page.chars, page.truncated)
    return page


async def _fetch_url(url: str) -> dict:
    """Fetch a public web page over http/https and return its readable content.

    Use this to read a page the user points you at, or a link you found while
    reading one. Private, loopback and internal addresses are refused.

    Args:
        url: Absolute http(s) URL of the page to read.

    Returns:
        A dict with the final `url` (after redirects), the page `title`, its
        readable `text`, the text length in `chars`, whether the text was cut
        short (`truncated`), and the response `content_type`.
    """
    page = await fetch_page(url)
    return page.as_dict()


# Picked up automatically by `tools.discover_tools()`.
TOOL = StructuredTool.from_function(
    coroutine=_fetch_url,
    name="fetch_url",
    description=(
        "Fetch a public http(s) web page and return its title and readable text. "
        "Input: url (absolute http or https URL). Private/internal addresses, "
        "non-text responses and oversized pages are refused with an explanation. "
        "Long pages come back truncated, flagged by the 'truncated' field."
    ),
)
