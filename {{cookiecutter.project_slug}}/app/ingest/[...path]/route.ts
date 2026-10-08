import { NextRequest } from "next/server";

/**
 * The first-party proxy PostHog is reached through: lib/analytics.ts points
 * posthog-js at /ingest, on this app's own domain, and this forwards each
 * request to PostHog. The visitor's browser never contacts PostHog itself, and
 * PostHog never learns who the visitor is beyond what the event says: their
 * cookies and IP address stay here. See docs/compliance.md, "Analytics and
 * consent".
 *
 * /ingest/static/* (PostHog's scripts) goes to POSTHOG_ASSETS_HOST and
 * everything else to POSTHOG_HOST, both read at request time. The defaults are
 * PostHog's US cloud; an EU project sets https://eu.i.posthog.com and
 * https://eu-assets.i.posthog.com.
 */

// Only these request headers are passed on. In particular not Cookie (this
// app's session and consent cookies are none of PostHog's business) and none
// of the headers that carry the visitor's IP address (X-Forwarded-For,
// X-Real-IP, Forwarded, ...), which Caddy or another proxy in front adds, so
// PostHog sees this server's address instead.
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "content-encoding", "user-agent"];

// Only these response headers come back. Not Set-Cookie, and not
// Content-Encoding or Content-Length: fetch() has already decompressed the
// body, so the originals would no longer describe it. Not Location either:
// a redirect from PostHog would send the visitor's browser to PostHog's own
// domain, so redirects are neither followed (redirect: "manual") nor passed
// on, and posthog-js sees a failed request instead.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"];

function upstream(path: string[]): string {
  const assets = path[0] === "static";
  const host = assets
    ? process.env.POSTHOG_ASSETS_HOST || "https://us-assets.i.posthog.com"
    : process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  return `${host.replace(/\/+$/, "")}/${path.map(encodeURIComponent).join("/")}`;
}

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${upstream(path)}${req.nextUrl.pathname.endsWith("/") ? "/" : ""}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    console.error("[ingest] PostHog unreachable:", error instanceof Error ? error.message : error);
    return new Response(null, { status: 502 });
  }

  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export { forward as GET, forward as POST };
