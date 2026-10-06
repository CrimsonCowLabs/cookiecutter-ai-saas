# Compliance guide

Common legal risks for an app like this one, what the app already does about
each, and what is still up to you as its operator. Many of these penalties
are charged per visitor, per email or per work, so an app with no revenue can
still owe a lot.

> **This is not legal advice.** It explains how this codebase is built and
> points at the laws it was built with in mind. It does not make your app
> compliant with anything on its own, and laws change. Have a lawyer review
> your app, your policies and the `/legal` pages before you launch. Penalty
> figures are maximums, with the date they were checked and their source.

## The legal settings

Everything an operator has to supply lives in the `legal` section of
`config.ts`. Each string ships as a `REPLACE_WITH_...` placeholder; replace
every one before you launch.

| Setting | What it is |
|---------|------------|
| `minimumAge` | Visitors younger than this cannot create an account. 13 by default, the US line under COPPA; some EU countries set 14, 15 or 16 under the GDPR. |
| `marketingPostalAddress` | The physical postal address every marketing email must carry under CAN-SPAM. Your street address, a PO box registered with the US Postal Service, or a private mailbox registered with a commercial mail receiving agency under Postal Service rules. |
| `dmcaAgent` | Name, postal address, phone and email of your designated copyright (DMCA) agent, exactly as registered with the US Copyright Office. |
| `accessibility.contactEmail` | Where visitors report an accessibility barrier. |
| `accessibility.reviewDate` | When you last reviewed the accessibility statement, as `YYYY-MM-DD`. |
| `consentTextVersion` | The version of the consent text visitors agree to. Changing it invalidates every stored consent, so everyone is asked again; change it whenever you change what you collect. |

## The legal pages

`/legal` is a hub, linked from the footer, that lists the Privacy Policy, the
Terms of Service and one page per topic below. Each topic page has two parts,
"The risk" and "How this app handles it", and says it is not legal advice.
The topics are listed in `lib/legal-topics.ts`; one is linked only once its
page exists.

If you change how the app behaves on one of these topics, change its page
too. Every statement on them has to stay true of your app.

## The compliance check

`scripts/check_compliance.sh` proves what the topic pages say, against a
really running copy of the app in a real headless Chrome. It brings up
Postgres and Redis with `docker compose`, builds the app, runs it with
`next start`, and runs `tests/compliance/*.test.mjs` against it.

```bash
scripts/check_compliance.sh
```

It needs Docker, port 3000 free, and Chrome or Chromium (set `CHROME_PATH`
if it is not in a usual place). Run it on a fresh checkout, not your working
copy: it writes its own `.env.local`, so it refuses to run when one exists,
and it deletes the compose volumes when it finishes.

It checks that:

- `/legal` and every topic page it links to load without signing in, and the
  footer links to `/legal`;
- the home page, the sign-in and sign-up pages, the other public pages, the
  blog (when the project has one), every legal page and the dashboard make
  no request to another server.
- the home page, the sign-in and sign-up pages, the Privacy Policy and
  Terms, every legal page, the dashboard and the account settings pass an
  automated WCAG 2.2 AA audit in both the light and the dark theme, open
  with a working "Skip to content" link, and show a clearly visible focus
  outline on everything the keyboard can reach.

## Fonts and third-party requests

**The law and the risk.** Under the EU's GDPR, an IP address is personal
data. When a page loads a font, script, stylesheet or image from another
company's server, the visitor's browser sends that server their IP address,
and that needs a legal basis, usually consent. In January 2022 the Munich
Regional Court ordered a website to pay a visitor €100 and stop loading
Google Fonts from Google's servers (LG München I, judgment of 20 January
2022, case 3 O 17493/20). Each visitor can claim, demand letters followed in
bulk, and regulators can fine up to €20 million or 4% of worldwide annual
turnover, whichever is higher (GDPR Article 83(5)). As of October 2026.

**What the app does.**

- Fonts are loaded with `next/font` in `app/(main)/layout.tsx`, which
  downloads them at build time and serves them from the app's own domain.
- Stylesheets, scripts and images are all served from the app's own domain.
- Nothing contacts another server before the visitor consents. The only time
  a visitor's browser reaches another company is when they choose to, such
  as signing in with an outside account or, when billing is included,
  paying through Stripe Checkout.
- The compliance check loads each page with no consent given, aborts any
  request to another origin, and fails naming the host. A request to
  `fonts.googleapis.com` or `fonts.gstatic.com` is called out as Google Fonts.

**What you still have to do.**

- Add any new font with `next/font` (`next/font/google` or `next/font/local`),
  never with a `<link>` to Google Fonts or an `@import` from a font CDN.
- Self-host any other library, stylesheet or image rather than linking a CDN.
- Load anything that has to come from another server (analytics, chat
  widgets, embedded videos, maps) only after the visitor consents to it.
- When you add a public page, add it to the list in
  `tests/compliance/third-party-requests.test.mjs` so it is checked too.
- Run `scripts/check_compliance.sh` after changing a layout, a page's
  `<head>` or a third-party integration.

## Accessibility

**The law and the risk.** In the United States, many courts have applied
Title III of the Americans with Disabilities Act (ADA), which bars
discrimination by "places of public accommodation", to websites. The federal
circuits disagree on whether a business with no physical location is
covered, so where you and your plaintiffs are matters, but suits are filed
either way. No regulation names a
technical standard for private businesses' sites, but plaintiffs, courts and
settlements use the Web Content Accessibility Guidelines (WCAG) at level AA,
and thousands of website accessibility lawsuits are filed every year, many
of them against small businesses. A private plaintiff wins an injunction and
their attorney's fees; in California the Unruh Civil Rights Act adds damages
of at least $4,000 per violation (California Civil Code §52(a)), and in a
case brought by the Department of Justice the civil penalty for a first
violation exceeds $100,000 (28 CFR 36.504, adjusted for inflation each
year).

In the EU, the European Accessibility Act (Directive (EU) 2019/882) applies
from 28 June 2025 to a list of products and services sold to consumers.
The one most likely to reach a SaaS app is "e-commerce services": services
provided online "with a view to concluding a consumer contract", which
covers at least your sign-up and checkout flow if you sell to consumers in
the EU. Whether it reaches the rest of your product is less settled. Its
technical standard is EN 301 549, which
incorporates WCAG 2.1 AA. Each member state sets its own penalties and
enforces them through a market surveillance authority; Germany's
implementing law (BFSG) allows fines of up to €100,000 and orders to stop
offering the service. Microenterprises, those with fewer than 10 staff and
an annual turnover or balance sheet of no more than €2 million, are exempt
for services. As of October 2026.

**What the app does.**

- It targets WCAG 2.2 AA, a superset of the 2.1 AA that EN 301 549 asks
  for.
- The compliance check runs axe-core's WCAG 2.2 AA rules against the home
  page, sign-in, sign-up, the magic-link, contact and blog pages (when the
  project has them), the Privacy Policy and Terms, every page under `/legal`,
  the dashboard and the account settings, in the light and the dark theme
  and the one chosen at generation time, and allows no violations.
- Every page starts with a "Skip to content" link (`components/ui/skip-link.tsx`)
  that jumps past the navigation to the page's `<Main>`. The check presses
  Tab on each listed page and fails if the first stop is not that link, if
  it is not visible, or if following it does not move focus to `<main>`.
- Everything the keyboard can reach gets the same focus outline, a solid
  2px ring in the theme's text colour (`:focus-visible` in `app/globals.css`).
  The check tabs through each listed page in both themes and fails on any
  element whose outline is missing, thinner than 2px, the browser's default
  ring, or below 3:1 contrast against the background behind it.
- Text in the primary colour (`text-primary`, `link-primary`) is mixed 30%
  towards the theme's text colour, so a brand colour chosen for buttons is
  still readable as text. Muted text uses at least `text-base-content/60`,
  the faintest that clears 4.5:1 on the light theme's `base-100` and
  `base-200` backgrounds; use `/70` on `base-300`.
- `/legal/accessibility` is the accessibility statement: the target
  standard, the known limitations, how to report a barrier, and when the
  statement was last reviewed. The contact address and review date come
  from `legal.accessibility` in `config.ts`.

**What you still have to do.**

- Set `legal.accessibility.contactEmail` to an inbox someone reads, and
  answer what arrives there. Set `legal.accessibility.reviewDate` whenever
  you review the statement, and review it at least once a year and after
  any large change to the app.
- Keep the statement's "Known limitations" true: add anything you know does
  not work for everyone, and remove what you fix.
- Test by hand. Automated checks find only some real barriers. At least
  once before launch and after big changes, use the app with only a
  keyboard, with a screen reader (VoiceOver on macOS or iOS, NVDA on
  Windows), zoomed to 200%, and at a phone's width.
- When you add a page, add it to the page lists at the top of
  `tests/compliance/accessibility.test.mjs` (pages under `/legal` are found
  from the hub automatically), and render its content inside `<Main>` from
  `components/ui/skip-link.tsx`.
- If you change the primary colour or add a theme, run the check: if
  primary-coloured text fails contrast, raise the mix in `app/globals.css`.
- Give every image that carries meaning an `alt` text, every form field a
  visible label, and every icon-only button an accessible name. Don't
  convey anything by colour alone.
- Content you or your users publish (blog posts, uploaded files, AI output)
  is yours to keep accessible; the template only covers its own pages.
- If you serve the EU, check whether the microenterprise exemption applies to
  you; if it doesn't, the EAA expects the accessibility information that
  this statement starts, kept up to date, plus any national extras.
