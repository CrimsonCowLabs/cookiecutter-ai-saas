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
