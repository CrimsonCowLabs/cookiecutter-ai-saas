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

Name test files to run only those, for example
`scripts/check_compliance.sh tests/compliance/age-gate.test.mjs`.

It needs Docker, ports 3000{% if cookiecutter.include_stripe == "yes" %}, 3998{% endif %} and 3999 free,
and Chrome or Chromium (set `CHROME_PATH` if it is not in a usual place). Run it on a fresh checkout, not your working
copy: it writes its own `.env.local`, so it refuses to run when one exists,
and it deletes the compose volumes when it finishes.

It checks that:

- `/legal` and every topic page it links to load without signing in, and the
  footer links to `/legal`;
- no account is created without a passed age check, through any sign-in
  method the app offers, and no date of birth is kept anywhere (see
  [Children's privacy](#childrens-privacy-coppa));
{%- if cookiecutter.include_stripe == "yes" %}
- every subscribe and upgrade button has the plan's renewal terms beside it,
  and every Stripe Checkout the app opens repeats them and requires the
  terms-of-service box (see
  [Subscriptions and automatic renewal](#subscriptions-and-automatic-renewal));
{%- endif %}
- the home page, the sign-in and sign-up pages, the other public pages, the
  blog (when the project has one), every legal page and the dashboard make
  no request to another server.
- the home page, the sign-in page, the sign-up page in each of its states
  (age screen, with an error, passed, turned away), the Privacy Policy and
  Terms, every legal page, the dashboard and the account settings pass an
  automated WCAG 2.2 AA audit in both the light and the dark theme, open
  with a working "Skip to content" link, and show a clearly visible focus
  outline on everything the keyboard can reach.

## Children's privacy (COPPA)

**The law and the risk.** The US Children's Online Privacy Protection Act
(COPPA, 15 U.S.C. 6501–6506, and the FTC's COPPA Rule, 16 CFR Part 312)
forbids an online service from collecting personal information, an email
address included, from a child under 13 without first getting verifiable
parental consent. It applies to a service directed to children, and to a
general-audience service that has actual knowledge it is collecting from a
child. The FTC enforces it with civil penalties of up to $53,088 per
violation (16 CFR 1.98, adjusted for inflation each year), and each child
can count as a violation. Under the EU's GDPR (Article 8), a child can
consent alone from 16, or from as young as 13 where a member state has
lowered it. As of October 2026.

Sign-up used to ask for no age, so an account could be created for anyone,
by Google, Microsoft or magic link alike.

**What the app does.**

- **An age screen before every new account.** `/sign-up` first shows only a
  date-of-birth form (`components/auth/age-screen.tsx`); the Google and
  Microsoft buttons and the magic-link form appear once it is passed. It is
  neutral, as the FTC's COPPA FAQ asks of age screens: it asks for a full
  date, starts empty, and doesn't say what age is needed. It is a plain form
  posted to `/api/age-check`, so it works without JavaScript, and an error is
  announced to screen readers.
- **Passed or turned away, in a signed cookie.** Someone at least
  `legal.minimumAge` gets a signed "passed" cookie that lasts an hour.
  Someone younger gets a signed "turned away" cookie that lasts a day; until
  it expires the page tells them, plainly, that an account can't be created,
  and won't ask again (`lib/age-check.ts`).
- **Enforced where accounts are made.** Every sign-in passes through the
  Auth.js `signIn` callback in `lib/auth.ts`. One that would create a new
  account, from any provider and whether it started on the sign-up or the
  sign-in page, is sent back to the age screen unless the visitor holds a
  valid "passed" cookie and no "turned away" one. A magic link is refused
  before it is even sent. The adapter's `createUser` checks again and refuses
  to insert a user without a passed check. Sign-ins to existing accounts are
  never blocked.
- **No date of birth anywhere.** The date is checked in `/api/age-check` and
  dropped. It is not in the database, the cookies or the logs. The `users`
  table records only `age_check_passed_at`, when the check was passed; it is
  null for accounts created before the age gate existed (they are
  grandfathered).
- **A notice.** `/legal/children` and the Privacy Policy's "Children's
  Privacy" section state the minimum age and tell parents how to reach you.
- The compliance check signs up through every provider the app offers
  (Google and Microsoft through a stand-in sign-in server,
  `tests/compliance/fake-oidc.mjs`) and proves all of the above against the
  running app, including that the line sits exactly at `legal.minimumAge`.

**What you still have to do.**

- Don't direct the app at children. An age screen is only enough for a
  general-audience service: if your content, ads or marketing are aimed at
  under-13s, COPPA requires verifiable parental consent, which this template
  does not provide.
- Set `legal.minimumAge` for the markets you serve. 13 is the US line; raise
  it to 16 (or the age a member state has set) if you serve the EU, since
  the app has no parental-consent flow. The screen, the notice and the
  Privacy Policy all follow it.
- Answer parents. The children's privacy notice gives the Privacy Policy's
  contact address; if a parent tells you a child under the minimum age has
  an account, delete the account and everything connected to it, and
  confirm it to them.
- Don't add a second way to create users. Anything that inserts into
  `users` outside Auth.js (an admin "invite user" form, an import) has to
  run the same check, or it bypasses the gate.
- Know the limitation: a new user's magic link only works in the browser
  that passed the age screen, within the hour. Opened elsewhere, it sends
  them back to the age screen to answer it there and ask for a new link.

{% if cookiecutter.include_stripe == "yes" -%}
## Subscriptions and automatic renewal

**The law and the risk.** California's Automatic Renewal Law (ARL, Business
and Professions Code §§17600–17606, as amended by AB 2863 from 1 July 2025)
applies to any subscription sold to a California consumer that renews
without the customer asking again. Before the customer pays, the business
must show the renewal terms "clearly and conspicuously" and right next to
the request for consent: that the subscription continues until cancelled,
how to cancel, what will be charged, and how often. It must get the
customer's express affirmative consent to those terms, send an
acknowledgement that includes them and how to cancel, and let a customer
who subscribed online cancel online, without a phone call or a chat. Goods or
services supplied without that consent count as an unconditional gift
(§17603), so the customer can recover what they paid, and a violation is
also unfair competition, with civil penalties of up to $2,500 per violation
in a public enforcement action (§17206) and class actions in practice. Many
other states have similar laws, and the federal Restore Online Shoppers'
Confidence Act (ROSCA, 15 U.S.C. 8401–8405) requires the same disclosure,
consent and simple cancellation for every online sale with a recurring
charge; the FTC enforces it with civil penalties of up to $53,088 per
violation (16 CFR 1.98). As of October 2026.

Subscribe buttons used to show only a price, and Stripe Checkout said
nothing about renewal.

**What the app does.**

- **One source for the terms.** `lib/renewal-terms.ts` writes each plan's
  terms from its own `price`, `currency` and `interval` in `config.ts`'s
  `stripe.plans`: that it renews automatically every interval until
  cancelled, what is charged and when, and how to cancel online. Free plans,
  and anything that does not renew, get none.
- **Beside every subscribe button.** `components/billing/renewal-terms.tsx`
  shows the terms directly under each paid plan's button on the landing
  page's pricing cards and under each upgrade button in the dashboard
  settings, and links the button to them with `aria-describedby`, so a
  screen reader reads them with the button. The cards' prices come from the
  same config.
- **Repeated at checkout, with consent required.** Every subscription
  Checkout Session (`createCheckout` in `lib/stripe.ts`), including the one
  the app opens on its own after sign-up for a plan picked beforehand,
  carries the same text beside Stripe's pay button (`custom_text.submit`) and
  requires the customer to tick a terms-of-service box, worded to include
  automatic renewal and linking to `/tos`, before paying
  (`consent_collection.terms_of_service`). Stripe records that consent on the
  session.
- **Cancel online.** Settings → Manage billing opens the Stripe billing
  portal, where the customer cancels. Access lasts until the end of the
  paid period.
- **The notice.** `/legal/subscriptions` explains renewal, cancellation and
  refunds and lists each plan's terms; the Terms of Service have a
  "Payment and Automatic Renewal" section linking to it.
- The compliance check reads the plans out of `config.ts` and proves, in a
  real browser against the running app, that every subscribe button has the
  right terms beside it and that each Checkout Session the app creates
  carries them and requires consent. The app's Stripe client is pointed at a
  stand-in API for that (`tests/compliance/fake-stripe.mjs`, through
  `STRIPE_API_BASE`, which you leave unset).

**What you still have to do.**

- Keep `price`, `currency` and `interval` in `config.ts` equal to the Stripe
  Price each plan's `priceId` points at. The terms quote the config, and the
  customer is charged the Price; if they differ, the terms are wrong.
- In the Stripe Dashboard, under Settings → Public details, set your Terms of
  Service URL (`https://{{ cookiecutter.domain_name }}/tos`). Stripe refuses to create a
  Checkout Session that requires terms-of-service consent until it is set.
- Turn on cancellation in the customer portal (Settings → Billing → Customer
  portal: allow customers to cancel subscriptions). Without it, Manage
  billing has no cancel button and the app's promise of online cancellation
  is false. Don't add a step that makes cancelling harder than subscribing,
  such as a required call or chat.
- Send the acknowledgement. Turn on Stripe's email receipts for successful
  payments (Settings → Customer emails), and make sure what the customer
  gets after subscribing states the renewal terms and how to cancel; add
  them to your receipt or welcome email if it does not.
- Send renewal reminders. The app does not send them. The ARL requires a
  yearly reminder of the terms and how to cancel for every subscription, and
  a notice before a free trial or promotional price longer than 31 days
  converts. Turn on Stripe's "Send emails about upcoming renewals" (Settings
  → Billing → Subscriptions and emails) for yearly plans, and send the yearly
  reminder to monthly subscribers yourself.
- Before raising a price, tell existing subscribers, with time to cancel
  first; the Terms of Service promise it. The ARL requires notice of a
  material change.
- Write your refund policy. `/legal/subscriptions` and the Terms of Service
  say a partly used period is not refunded except where the law requires;
  change both if you offer more, and honour refunds some countries require
  (the EU's 14-day withdrawal right, for one, unless the customer waived it
  when service started).
- If you add a free trial, a discount that later rises to the full price, or
  another plan, its terms must say so: extend `lib/renewal-terms.ts` and
  check the result on the landing page and in Checkout.

{% endif -%}
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
