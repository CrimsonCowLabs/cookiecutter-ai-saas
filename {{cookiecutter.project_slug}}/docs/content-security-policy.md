# Content Security Policy

Every page this app serves carries a `Content-Security-Policy` header that
stops any script the server didn't hand out from running. It is the backstop
behind everything a page shows that the app didn't write itself: an
AI-generated report, a title pulled off a third-party page, anything a user
typed. React already escapes all of that. If something ever slips through,
through a bug, a new component that sets HTML directly, or a dependency, the
browser still refuses to run the script.

The policy is built in `lib/csp.ts` and attached in `middleware.ts`, fresh for
every request.

> **Every route renders dynamically.** `app/layout.tsx` calls
> `await connection()`, so no page is prerendered at build time: no static
> generation, no ISR, and no serving pages from a static cache or CDN. The
> policy's nonce is new for each response, and Next.js can only put it on a
> page's scripts while rendering that response, so a page rendered ahead of
> time would carry no nonce and none of its scripts would run. See
> [Why nonces](#why-nonces).

## The policy

| Directive | Value | Why |
|-----------|-------|-----|
| `default-src` | `'self'` | Anything not listed below comes from this app's own origin only. |
| `script-src` | `'self' 'nonce-…' 'strict-dynamic'` | A script runs only if it carries this response's nonce, or was loaded by one that did. No `'unsafe-inline'`, and no `'unsafe-eval'` outside `next dev`. |
| `style-src` | `'self' 'unsafe-inline'` | See [Styles](#styles). |
| `img-src` | `'self' data: blob:` | `next/image` serves remote pictures, such as avatars, through `/_next/image` on this origin. |
| `font-src` | `'self'` | `next/font` serves the fonts from this origin. |
| `connect-src` | `'self'` | `fetch()` and the job progress stream{% if cookiecutter.analytics == "posthog" %}, and analytics, which talks only to the first-party `/ingest` proxy{% endif %}. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | An injected `<base>` can't redirect the page's relative URLs. |
| `form-action` | `'self'`{% if cookiecutter.auth_providers != "microsoft_only" %} `https://accounts.google.com`{% endif %}{% if cookiecutter.auth_providers != "google_only" %} `https://login.microsoftonline.com`{% endif %}{% if cookiecutter.include_stripe == "yes" %} `https://checkout.stripe.com` `https://billing.stripe.com`{% endif %} | Where a form may send the visitor. See [Forms](#forms). |
| `frame-ancestors` | `'none'` | No other site may put this app in a frame, which stops clickjacking. |
| `report-uri` | `/api/csp-report` | Where browsers report what the policy blocked. See [Reports](#reports). |

### Why nonces

Next.js writes inline scripts into every page it renders, so a policy without
`'unsafe-inline'` has to allow them some other way. Each request gets a fresh
random nonce. Middleware puts the policy on the request as well as the
response, and Next.js reads the nonce from the request and adds it to every
script it renders. Injected markup can't guess the nonce, so it doesn't run.
`'strict-dynamic'` lets those scripts load the rest of the app's code chunks
without listing them.

A nonce only works if the page is rendered for that request, so no page is
prerendered at build time: `app/layout.tsx` calls `connection()`, which makes
every page dynamic. Pages can't be served from a static cache or a CDN as a
result. That's the cost of a nonce-based policy.

Middleware also hands the nonce on by itself, as the `x-nonce` request
header. To add a script of your own, read it there in a server component and
pass it on:

```tsx
import { headers } from "next/headers";
import Script from "next/script";

const nonce = (await headers()).get("x-nonce") ?? undefined;
return <Script src="/vendor/widget.js" nonce={nonce} />;
```

JSON-LD blocks (`lib/seo.tsx`) are data, not scripts, so they need no nonce.

### Styles

`style-src` keeps `'unsafe-inline'`. React writes `style="…"` attributes (a
progress bar's width, for example), and the page-load bar injects a `<style>`
element. A stylesheet can't run code, so this doesn't weaken the script rule.
Don't add a nonce to `style-src`: browsers ignore `'unsafe-inline'` once a
nonce is present, and those inline styles would break.

### zod

zod 4 builds faster parsers with `new Function`, and checks whether it can by
calling it once. The policy blocks that call in the browser, and the browser
reports it as a violation even though zod falls back on its own. `lib/zod.ts`
turns that off (`jitless`), so import `z` from `@/lib/zod`, never from `zod`
directly. ESLint enforces this.

### Forms

Chrome checks `form-action` against every redirect that follows a form
submission, not just the form's own `action`. Sign-in redirects to the
identity provider{% if cookiecutter.include_stripe == "yes" %}, and checkout and the billing portal redirect to Stripe{% endif %}.
When that starts from a form the browser submits itself (a server action, or
any page before its JavaScript has loaded), the provider has to be listed or
the redirect is blocked. The sign-in buttons on `/sign-in` navigate from
script, which `form-action` doesn't govern, but a sign-in form wouldn't.

`lib/csp.ts` derives each origin from the setting the app already uses for that
provider. In production those settings are unset and the real providers are
listed. The compliance check points the app at stand-in servers
({% if cookiecutter.auth_providers != "microsoft_only" %}`AUTH_GOOGLE_ISSUER`{% endif %}{% if cookiecutter.auth_providers == "google_microsoft" %}, {% endif %}{% if cookiecutter.auth_providers != "google_only" %}`AUTH_MICROSOFT_ENTRA_ID_ISSUER`{% endif %}{% if cookiecutter.include_stripe == "yes" %}, `STRIPE_API_BASE`{% endif %}), and the policy then lists
the stand-ins' origins instead.

## Reports

Browsers send each violation to `/api/csp-report` (`app/api/csp-report/route.ts`),
which logs it as one line:

```
[csp-violation] {"documentURL":"https://…/dashboard","blockedURL":"https://cdn.example.com/x.js","effectiveDirective":"script-src-elem","disposition":"enforce",…}
```

Anyone can post to the endpoint, so it caps the body at 64 KB, logs only a few
known fields, and strips query strings and fragments from URLs, since a page's
URL can carry a sign-in or unsubscribe token. Search the app's logs for
`[csp-violation]`.

The policy uses `report-uri` and not `report-to`. When a policy names a
`report-to` endpoint, Chrome ignores `report-uri` and uses the Reporting API
instead, which only works on HTTPS pages and sends reports in batches up to a
minute later. Nothing would arrive from `next dev` or from the compliance
check. The endpoint accepts the Reporting API's format too
(`application/reports+json`), so you can add `report-to` later.

## Report-only mode

`CSP_REPORT_ONLY=true` sends the same policy as
`Content-Security-Policy-Report-Only`. Browsers then block nothing and report
everything the policy would block. It's off by default, which means the
policy is enforced. Use it to try a change in production before enforcing it.
Locally, set it in `.env.local`. In production, deploy with
`-e csp_report_only=true`, which `ansible/templates/env-app.j2` renders into
`.env-app`.

## Allowing a new third-party origin

Every origin you add is another server that can run code in, or receive data
from, your visitors' browsers. Ask the same questions as for any third party.
Under the rule in `docs/compliance.md` ("Fonts and third-party requests"),
nothing may contact another server before the visitor consents. Prefer
self-hosting, or a proxy route on this app's own origin{% if cookiecutter.analytics == "posthog" %} (as `/ingest` is for analytics){% endif %}.
Neither needs a policy change.

If the browser really has to reach the other origin:

1. **Find the directive.** Check what the browser loads from the origin:
   - `fetch` or XHR calls: `connect-src`.
   - Images: `img-src`.
   - Fonts: `font-src`.
   - Stylesheets: `style-src`.
   - An iframe you embed: `frame-src`.
   - A form that posts there, or a form whose redirect lands there:
     `form-action`.
   - A script: see step 3.
2. **Add the origin in `lib/csp.ts`.** Add it to that directive's list in
   `contentSecurityPolicy`, as an exact origin (`https://api.example.com`),
   never a wildcard or a bare scheme. If the origin depends on a setting, read
   the setting in `cspEnv()` (Edge middleware only sees variables its code
   names in full) and derive the origin the way `formActionOrigins` does.
3. **Scripts are different.** With `'strict-dynamic'`, browsers ignore host
   names in `script-src`, so adding one does nothing. Load the script with a
   `<Script>` that carries the nonce (see [Why nonces](#why-nonces)). Anything
   that script loads in turn is then allowed too. Load it only after consent.
4. **Update the policy test.** `tests/csp/policy.test.mjs` asserts the
   directives' exact values, so add the new origin there and run
   `npm run test:csp`.
5. **Check it locally.** Run `scripts/check_compliance.sh`. Its
   `content-security-policy.test.mjs` fails on any violation in the normal
   flows. If the new integration is part of a flow, add that flow to the test.
6. **Roll out report-only.** Deploy with `CSP_REPORT_ONLY=true`, use the
   feature in production, and watch the logs for `[csp-violation]` lines.
   Each one names the directive and the blocked URL.
7. **Enforce.** Once normal use logs no violations, deploy again without
   `CSP_REPORT_ONLY`.

If you need another site to frame this app, change `frame-ancestors` from
`'none'` to that site's origin. Never use `*`.

## How it's checked

- `tests/csp/policy.test.mjs` (`npm run test:csp`, no server) holds the policy
  string to these rules: scripts by nonce only, `'unsafe-eval'` only in
  development, the `form-action` origins this project was generated with and
  no others, a fresh nonce on every request, and report-only only when asked.
- `tests/compliance/content-security-policy.test.mjs`, part of
  `scripts/check_compliance.sh`, runs against the real app in a headless
  Chrome. It checks that every page, redirect and 404 carries an enforcing
  policy with a fresh nonce on all of its scripts. It checks that the normal
  flows run without a single violation: the public{% if cookiecutter.include_marketing_extras == "yes" %}, blog{% endif %} and legal pages, the age
  screen, each sign-in button and a form-posted sign-in, the dashboard and a
  job report{% if cookiecutter.include_stripe == "yes" %}, checkout with and without JavaScript{% endif %}{% if cookiecutter.analytics == "posthog" %}, and accepting analytics{% endif %}. It checks that an inline
  `<script>` and an inline event handler injected into a page don't run, and
  that the browser reports them to `/api/csp-report`. Finally it checks that
  the endpoint accepts both report formats, strips query strings from what it
  logs, and refuses anything oversized or malformed.
