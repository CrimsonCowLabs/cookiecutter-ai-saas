"""Tests for the fetch_url tool: extraction, the SSRF guard, and the HTTP limits.

Everything runs offline. The extractor is pure; the guard takes an injected
resolver; the HTTP layer takes an injected opener. Nothing here opens a socket.
"""

import socket

import pytest

from tests.fakes import FakeHTTPResponse, fake_fetcher, public_resolver
from tools.fetch_url import (
    ALLOWED_CONTENT_TYPES,
    MAX_REDIRECTS,
    FetchError,
    PageContent,
    RawResponse,
    extract,
    fetch_page,
    http_get,
    validate_url,
)

PUBLIC = "https://example.com/article"


def html(body: str, title: str = "Example Article") -> RawResponse:
    return RawResponse(
        url=PUBLIC,
        content_type="text/html",
        body=f"<html><head><title>{title}</title></head><body>{body}</body></html>",
    )


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------


def test_extracts_title_and_readable_text():
    page = extract(html("<h1>Headline</h1><p>First para.</p><p>Second para.</p>"))

    assert isinstance(page, PageContent)
    assert page.title == "Example Article"
    assert page.text == "Headline\nFirst para.\nSecond para."
    assert page.chars == len(page.text)
    assert page.truncated is False
    assert page.url == PUBLIC


def test_drops_script_style_nav_and_footer():
    page = extract(
        html(
            "<script>var secret = 1;</script>"
            "<style>body { color: red; }</style>"
            "<nav>Home About Contact</nav>"
            "<p>Keep this.</p>"
            "<footer>Copyright notice</footer>"
            "<noscript>Enable JS</noscript>"
        )
    )

    assert page.text == "Keep this."
    for dropped in ("secret", "color: red", "About", "Copyright", "Enable JS"):
        assert dropped not in page.text


def test_skipping_survives_nesting_and_self_closing_tags():
    page = extract(html("<nav><ul><li>Menu</li></ul></nav><svg/><p>Body.</p>"))

    assert page.text == "Body."


def test_collapses_whitespace_and_decodes_entities():
    page = extract(html("<p>Tabs\tand\n   spaces &amp; &lt;entities&gt;</p>"))

    assert page.text == "Tabs and spaces & <entities>"


def test_truncation_is_bounded_and_flagged():
    page = extract(html("<p>" + "x" * 500 + "</p>"), max_chars=100)

    assert page.truncated is True
    assert page.chars == 100
    assert len(page.text) == 100


def test_text_under_the_budget_is_not_flagged():
    page = extract(html("<p>short</p>"), max_chars=100)

    assert page.truncated is False
    assert page.text == "short"


def test_plain_text_is_passed_through_without_a_title():
    page = extract(RawResponse(url=PUBLIC, content_type="text/plain", body="line one\n\nline two"))

    assert page.title == ""
    assert page.text == "line one\nline two"


def test_json_is_passed_through_unparsed():
    page = extract(RawResponse(url=PUBLIC, content_type="application/json", body='{"a": 1}'))

    assert page.text == '{"a": 1}'
    assert page.content_type == "application/json"


def test_missing_title_yields_an_empty_string():
    page = extract(RawResponse(url=PUBLIC, content_type="text/html", body="<p>No head here.</p>"))

    assert page.title == ""
    assert page.text == "No head here."


# --------------------------------------------------------------------------
# SSRF guard
# --------------------------------------------------------------------------


def never_resolves(host, port, **kwargs):
    raise AssertionError("the guard resolved a URL it should have rejected on sight")


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "javascript:alert(1)",
        "example.com/no-scheme",
    ],
)
def test_only_http_and_https_are_allowed(url):
    with pytest.raises(FetchError, match="only http and https"):
        validate_url(url, resolve=never_resolves)


def test_a_url_with_no_host_is_rejected():
    with pytest.raises(FetchError, match="no host"):
        validate_url("http:///path", resolve=never_resolves)


@pytest.mark.parametrize(
    "address,expected",
    [
        ("127.0.0.1", "loopback"),
        ("10.0.0.5", "private"),
        ("192.168.1.1", "private"),
        ("172.16.0.1", "private"),
        ("169.254.169.254", "link-local"),  # the cloud metadata endpoint
        ("240.0.0.1", "reserved"),
        ("224.0.0.1", "multicast"),
        ("0.0.0.0", "unspecified"),
        ("100.64.0.1", "non-public"),  # carrier NAT
        ("::1", "loopback"),
        ("fd00::1", "private"),
        ("fe80::1", "link-local"),
    ],
)
def test_internal_addresses_are_refused(address, expected):
    with pytest.raises(FetchError, match=f"refusing to fetch.*{expected}"):
        validate_url("http://internal.test/", resolve=public_resolver(address))


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "2606:2800:220:1::1"])
def test_public_addresses_are_allowed(address):
    assert validate_url(PUBLIC, resolve=public_resolver(address)) == PUBLIC


def test_one_bad_address_out_of_several_refuses_the_whole_host():
    def resolve(host, port, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    with pytest.raises(FetchError, match="loopback"):
        validate_url(PUBLIC, resolve=resolve)


def test_a_host_that_does_not_resolve_is_a_fetch_error():
    def resolve(host, port, **kwargs):
        raise socket.gaierror("nodename nor servname provided")

    with pytest.raises(FetchError, match="could not resolve host"):
        validate_url("https://nope.invalid/", resolve=resolve)


def test_a_host_that_resolves_to_nothing_is_a_fetch_error():
    with pytest.raises(FetchError, match="no addresses"):
        validate_url(PUBLIC, resolve=lambda host, port, **kwargs: [])


def test_an_ipv6_scope_id_is_stripped_before_classification():
    with pytest.raises(FetchError, match="link-local"):
        validate_url("http://internal.test/", resolve=public_resolver("fe80::1%eth0"))


# --------------------------------------------------------------------------
# HTTP: redirects, size cap, content types
# --------------------------------------------------------------------------


def opener_returning(*responses):
    """An opener that returns `responses` in order and records the URLs asked for."""
    asked: list[str] = []
    queue = list(responses)

    def open_(request, timeout):
        asked.append(request.full_url)
        assert queue, f"opener called more times than scripted ({asked})"
        return queue.pop(0)

    open_.asked = asked
    return open_


def ok(body: bytes = b"<p>Body.</p>", content_type: str = "text/html"):
    return FakeHTTPResponse(200, {"Content-Type": content_type}, body)


def redirect(location: str, status: int = 302):
    return FakeHTTPResponse(status, {"Location": location}, b"")


def test_a_successful_get_returns_the_decoded_body():
    opener = opener_returning(ok(b"<p>Caf\xc3\xa9</p>", "text/html; charset=utf-8"))

    response = http_get(PUBLIC, opener=opener, resolve=public_resolver())

    assert response.url == PUBLIC
    assert response.content_type == "text/html"
    assert "Café" in response.body


def test_a_declared_charset_is_honoured():
    opener = opener_returning(ok("<p>Café</p>".encode("latin-1"), "text/html; charset=latin-1"))

    response = http_get(PUBLIC, opener=opener, resolve=public_resolver())

    assert "Café" in response.body


def test_an_unknown_charset_falls_back_to_utf8():
    opener = opener_returning(ok(b"<p>ok</p>", "text/html; charset=not-a-codec"))

    assert "ok" in http_get(PUBLIC, opener=opener, resolve=public_resolver()).body


def test_redirects_are_followed_and_the_final_url_is_reported():
    opener = opener_returning(
        redirect("https://example.com/moved"),
        redirect("/final", status=301),
        ok(),
    )

    response = http_get(PUBLIC, opener=opener, resolve=public_resolver())

    assert response.url == "https://example.com/final"  # relative Location resolved
    assert opener.asked == [PUBLIC, "https://example.com/moved", "https://example.com/final"]


def test_a_redirect_onto_a_private_address_is_refused():
    """The classic SSRF bypass: a public first hop pointing at an internal host."""
    opener = opener_returning(redirect("http://169.254.169.254/latest/meta-data/"), ok())

    def resolve(host, port, **kwargs):
        address = "169.254.169.254" if host == "169.254.169.254" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    with pytest.raises(FetchError, match="link-local"):
        http_get(PUBLIC, opener=opener, resolve=resolve)

    # The internal hop was never opened.
    assert opener.asked == [PUBLIC]


def test_too_many_redirects_is_refused():
    hops = [redirect(f"https://example.com/hop{i}") for i in range(MAX_REDIRECTS + 1)]
    opener = opener_returning(*hops)

    with pytest.raises(FetchError, match=f"more than {MAX_REDIRECTS} redirects"):
        http_get(PUBLIC, opener=opener, resolve=public_resolver())

    assert len(opener.asked) == MAX_REDIRECTS + 1


def test_a_redirect_without_a_location_is_refused():
    opener = opener_returning(FakeHTTPResponse(302, {}, b""))

    with pytest.raises(FetchError, match="no Location header"):
        http_get(PUBLIC, opener=opener, resolve=public_resolver())


@pytest.mark.parametrize("status", [400, 404, 418, 500, 503])
def test_http_error_statuses_are_refused(status):
    opener = opener_returning(FakeHTTPResponse(status, {"Content-Type": "text/html"}, b"nope"))

    with pytest.raises(FetchError, match=f"HTTP {status}"):
        http_get(PUBLIC, opener=opener, resolve=public_resolver())


@pytest.mark.parametrize(
    "content_type", ["image/png", "application/pdf", "application/octet-stream", ""]
)
def test_non_text_content_types_are_refused(content_type):
    opener = opener_returning(ok(b"\x89PNG", content_type))

    with pytest.raises(FetchError, match="unsupported content type"):
        http_get(PUBLIC, opener=opener, resolve=public_resolver())


@pytest.mark.parametrize("content_type", sorted(ALLOWED_CONTENT_TYPES))
def test_every_allowed_content_type_is_accepted(content_type):
    opener = opener_returning(ok(b"body", content_type))

    assert http_get(PUBLIC, opener=opener, resolve=public_resolver()).content_type == content_type


def test_an_oversized_body_is_refused_while_reading():
    opener = opener_returning(ok(b"x" * 5_000))

    with pytest.raises(FetchError, match="exceeded the 1000 byte limit"):
        http_get(PUBLIC, max_bytes=1_000, opener=opener, resolve=public_resolver())


def test_a_body_at_the_limit_is_accepted():
    opener = opener_returning(ok(b"x" * 1_000))

    response = http_get(PUBLIC, max_bytes=1_000, opener=opener, resolve=public_resolver())

    assert len(response.body) == 1_000


def test_the_response_is_closed_even_when_it_is_rejected():
    response = ok(b"\x89PNG", "image/png")
    opener = opener_returning(response)

    with pytest.raises(FetchError):
        http_get(PUBLIC, opener=opener, resolve=public_resolver())

    assert response.closed is True


def test_a_transport_failure_becomes_a_fetch_error():
    from urllib.error import URLError

    def open_(request, timeout):
        raise URLError("connection refused")

    with pytest.raises(FetchError, match="connection refused"):
        http_get(PUBLIC, opener=open_, resolve=public_resolver())


def test_a_timeout_becomes_a_fetch_error():
    def open_(request, timeout):
        raise TimeoutError("timed out")

    with pytest.raises(FetchError, match="timed out"):
        http_get(PUBLIC, opener=open_, resolve=public_resolver())


# --------------------------------------------------------------------------
# fetch_page
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_page_extracts_from_the_injected_fetcher():
    page = await fetch_page(PUBLIC, fetcher=fake_fetcher())

    assert page.title == "Example"
    assert page.text == "Hello."


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "   ", None])
async def test_fetch_page_rejects_a_blank_url(blank):
    with pytest.raises(FetchError, match="no URL given"):
        await fetch_page(blank, fetcher=fake_fetcher())


@pytest.mark.asyncio
async def test_fetch_page_runs_the_blocking_fetch_off_the_event_loop():
    """BullMQ needs the loop free to extend the job lock, so the fetch must thread."""
    import threading

    loop_thread = threading.current_thread()
    seen: list[threading.Thread] = []

    def fetch(url):
        seen.append(threading.current_thread())
        return RawResponse(url=url, content_type="text/plain", body="ok")

    await fetch_page(PUBLIC, fetcher=fetch)

    assert seen and seen[0] is not loop_thread


@pytest.mark.asyncio
async def test_fetch_page_honours_the_character_budget():
    page = await fetch_page(PUBLIC, fetcher=fake_fetcher("<p>" + "y" * 200 + "</p>"), max_chars=50)

    assert page.truncated is True
    assert page.chars == 50


@pytest.mark.asyncio
async def test_the_tool_is_registered_with_a_usable_schema():
    from tools.fetch_url import TOOL

    assert TOOL.name == "fetch_url"
    assert set(TOOL.args) == {"url"}
    assert "http" in TOOL.description


def test_the_real_opener_turns_a_redirect_into_a_response(monkeypatch):
    """The manual redirect loop depends on 3xx coming back, not raising."""
    import urllib.error

    from tools import fetch_url

    error = urllib.error.HTTPError(PUBLIC, 302, "Found", {"Location": "/next"}, None)

    def raise_http_error(request, timeout):
        raise error

    monkeypatch.setattr(fetch_url._opener, "open", raise_http_error)

    response = fetch_url._open(object(), 1.0)

    assert response is error
    assert response.status == 302
    assert response.headers.get("Location") == "/next"


def test_the_real_opener_does_not_follow_redirects_itself():
    from tools.fetch_url import _NoRedirect, _opener

    handlers = [type(h).__name__ for h in _opener.handlers]
    assert "_NoRedirect" in handlers
    assert _NoRedirect().redirect_request(None, None, 302, "", {}, PUBLIC) is None
