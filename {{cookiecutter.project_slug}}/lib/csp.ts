/**
 * The Content-Security-Policy every page is sent with, built fresh for each
 * request by middleware.ts. It is the backstop behind everything a page shows
 * that the app did not write itself — an AI-generated report, a page title
 * pulled off the web, anything a user typed: React escapes all of it, and if
 * something ever slips through anyway, the browser still refuses to run a
 * script the server did not hand out.
 *
 * Scripts run only with this request's nonce (or when loaded by one that
 * did, `'strict-dynamic'`). Next.js reads the nonce out of the request's
 * Content-Security-Policy header and puts it on every script it renders, so
 * nothing here lists a script by name; an injected `<script>` has no nonce
 * and does not run. Everything else is this app's own origin, except where a
 * form is allowed to send the visitor: the sign-in providers and Stripe this
 * project was generated with.
 *
 * To allow another origin, see docs/content-security-policy.md. Pure and
 * Edge-safe: no Node APIs, so middleware can import it.
 */

/** Where browsers send violation reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The settings the policy depends on (see cspEnv). */
interface CspEnv {
  NODE_ENV?: string;
  /** "true" sends the policy report-only, for rolling out a change. */
  CSP_REPORT_ONLY?: string;
  // cc:begin google
  /** Unset in production; the compliance suite's stand-in Google. */
  AUTH_GOOGLE_ISSUER?: string;
  // cc:end google
  // cc:begin microsoft
  /** Unset in production; the compliance suite's stand-in Microsoft. */
  AUTH_MICROSOFT_ENTRA_ID_ISSUER?: string;
  // cc:end microsoft
  // cc:begin stripe
  /** Unset in production; the compliance suite's stand-in Stripe. */
  STRIPE_API_BASE?: string;
  // cc:end stripe
}

/**
 * The settings above, read from the environment at request time. Each is
 * named in full, because Edge middleware is only handed the variables its
 * code names.
 */
export function cspEnv(): CspEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
    // cc:begin google
    AUTH_GOOGLE_ISSUER: process.env.AUTH_GOOGLE_ISSUER,
    // cc:end google
    // cc:begin microsoft
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    // cc:end microsoft
    // cc:begin stripe
    STRIPE_API_BASE: process.env.STRIPE_API_BASE,
    // cc:end stripe
  };
}

/** A fresh, unguessable nonce: 128 random bits, base64. */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The origin of `url`, or null for anything that isn't an http(s) URL. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Where a form on this app may send the visitor, besides the app itself.
 * Chrome checks `form-action` against every redirect that follows a form
 * submission, so a sign-in or checkout started from a plain form (before the
 * page has hydrated, or from a server action) has to be allowed to land on
 * the provider. Each origin is the one the app is configured to use: the
 * real provider in production, the stand-in when the compliance suite points
 * the app at one.
 */
function formActionOrigins(env: CspEnv): string[] {
  const origins: string[] = [];
  // cc:begin google
  origins.push(originOf(env.AUTH_GOOGLE_ISSUER) ?? "https://accounts.google.com");
  // cc:end google
  // cc:begin microsoft
  origins.push(originOf(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER) ?? "https://login.microsoftonline.com");
  // cc:end microsoft
  // cc:begin stripe
  // Checkout and the billing portal. lib/stripe.ts sends its API calls to
  // STRIPE_API_BASE when it is set, and the stand-in hands out checkout and
  // portal URLs on that same origin.
  const stripe = originOf(env.STRIPE_API_BASE);
  origins.push(...(stripe ? [stripe] : ["https://checkout.stripe.com", "https://billing.stripe.com"]));
  // cc:end stripe
  return [...new Set(origins)];
}

/**
 * The policy for one response, as a header value.
 *
 * `dev` adds `'unsafe-eval'` to script-src, which `next dev` needs (React
 * rebuilds server error stacks in the browser with eval) and production
 * never gets.
 */
function contentSecurityPolicy({
  nonce,
  dev = false,
  formActions = [],
}: {
  nonce: string;
  dev?: boolean;
  formActions?: string[];
}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    // Inline styles stay allowed: React writes style="" attributes (a
    // progress bar's width), and the page-load bar injects a <style>. A
    // stylesheet can't run code, so this costs the script rule nothing.
    // Adding a nonce here would switch 'unsafe-inline' off.
    "style-src": ["'self'", "'unsafe-inline'"],
    // next/image serves remote pictures (avatars) through /_next/image on
    // this origin, so only data: and blob: are added for generated images.
    "img-src": ["'self'", "data:", "blob:"],
    // next/font serves the fonts from this origin.
    "font-src": ["'self'"],
    // fetch() and EventSource (a job's live progress) talk to this origin.
    // cc:begin analytics
    // So does analytics: posthog-js is loaded from this origin and sends
    // only to the first-party /ingest proxy.
    // cc:end analytics
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", ...formActions],
    "frame-ancestors": ["'none'"],
    // report-uri only, not report-to as well: given a report-to, Chrome
    // ignores report-uri and reports through the Reporting API instead,
    // which it does only for HTTPS pages and in batches up to a minute
    // apart, so nothing would arrive from a plain-http dev or test server.
    // The endpoint accepts the Reporting API's format too, should you add it.
    "report-uri": [CSP_REPORT_PATH],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/**
 * The header the policy goes out in: report-only when `CSP_REPORT_ONLY` is
 * "true", enforcing otherwise.
 */
function cspHeaderName(env: CspEnv): string {
  return env.CSP_REPORT_ONLY?.trim().toLowerCase() === "true"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
}

/** Everything middleware needs for one request: the nonce, and the header's name and value. */
export function cspForRequest(env: CspEnv, nonce: string = generateNonce()) {
  return {
    nonce,
    name: cspHeaderName(env),
    value: contentSecurityPolicy({
      nonce,
      dev: env.NODE_ENV === "development",
      formActions: formActionOrigins(env),
    }),
  };
}
