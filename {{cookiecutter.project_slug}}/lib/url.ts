/**
 * URL helpers shared by validation and rendering.
 *
 * Job output contains strings scraped from a third-party page, so anything that
 * becomes an `href` has to go through here first — never interpolate a raw
 * string into a link (`javascript:` URLs are the obvious hazard).
 */

/** Parses an absolute http(s) URL. Returns null for anything else. */
export function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

export function isHttpUrl(value: unknown): boolean {
  return parseHttpUrl(value) !== null;
}

/** Returns an href that is safe to render, or null if the value isn't http(s). */
export function safeHttpHref(value: unknown): string | null {
  return parseHttpUrl(value)?.href ?? null;
}

/** `https://example.com/a/b?c=1` -> `example.com/a/b` (for compact display). */
export function displayUrl(value: unknown): string | null {
  const parsed = parseHttpUrl(value);
  if (!parsed) return null;
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.host}${path}`;
}
