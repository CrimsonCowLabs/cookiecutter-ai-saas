import { NextRequest, NextResponse } from "next/server";

/**
 * Where browsers report what the Content-Security-Policy (lib/csp.ts) blocked
 * or, in report-only mode, would have blocked. Each violation is logged as one
 * `[csp-violation]` line, which is how you find out a new third-party origin
 * still needs allowing before you switch enforcement back on (see
 * docs/content-security-policy.md).
 *
 * Two formats are accepted: the `report-uri` one the policy asks for
 * (application/csp-report, one `{"csp-report": {...}}`), and the Reporting
 * API's (application/reports+json, a list of `{type, body}`), which Chrome
 * sends instead if the policy ever names a `report-to` endpoint too (see
 * lib/csp.ts for why it doesn't).
 *
 * Anyone can post here, so the body is capped and nothing in it is trusted:
 * only a few known fields are logged, URLs lose their query string and
 * fragment (a page's URL can carry a sign-in or unsubscribe token), and every
 * value is cut short.
 */

// A real report is well under 4 KB; a batch of them under this.
const MAX_BODY_BYTES = 64 * 1024;

const ACCEPTED_TYPES = ["application/csp-report", "application/reports+json", "application/json"];

// The fields worth logging, by their Reporting API name: the names the older
// format uses for the same thing, and whether it's a URL (logged without its
// query string).
const FIELDS: Record<string, { names: string[]; url?: boolean }> = {
  documentURL: { names: ["documentURL", "document-uri"], url: true },
  blockedURL: { names: ["blockedURL", "blocked-uri"], url: true },
  effectiveDirective: { names: ["effectiveDirective", "effective-directive", "violated-directive"] },
  disposition: { names: ["disposition"] },
  sourceFile: { names: ["sourceFile", "source-file"], url: true },
  lineNumber: { names: ["lineNumber", "line-number"] },
  columnNumber: { names: ["columnNumber", "column-number"] },
  sample: { names: ["sample", "script-sample"] },
};

/** `value` without query or fragment if it's a URL, as is if it's a keyword ("inline", "eval"). */
function withoutQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function summarize(report: Record<string, unknown>): Record<string, string | number> {
  const summary: Record<string, string | number> = {};
  for (const [field, { names, url }] of Object.entries(FIELDS)) {
    const value = names.map((n) => report[n]).find((v) => typeof v === "string" || typeof v === "number");
    if (value === undefined || value === "") continue;
    summary[field] =
      typeof value === "number" ? value : (url ? withoutQuery(value) : value).slice(0, 200);
  }
  return summary;
}

/** The violation bodies in either format; anything else is ignored. */
function violations(payload: unknown): Record<string, unknown>[] {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (Array.isArray(payload)) {
    return payload
      .filter((r) => isRecord(r) && r.type === "csp-violation" && isRecord(r.body))
      .map((r) => r.body as Record<string, unknown>);
  }
  if (isRecord(payload) && isRecord(payload["csp-report"])) return [payload["csp-report"]];
  return [];
}

/** The body as text, or null once it passes MAX_BODY_BYTES. */
async function readCapped(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: NextRequest) {
  const type = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!ACCEPTED_TYPES.includes(type)) {
    return new NextResponse(null, { status: 415 });
  }

  const body = await readCapped(req);
  if (body === null) return new NextResponse(null, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // A batch is capped too, so one post can't fill the log.
  for (const report of violations(payload).slice(0, 20)) {
    console.warn(`[csp-violation] ${JSON.stringify(summarize(report))}`);
  }
  return new NextResponse(null, { status: 204 });
}
