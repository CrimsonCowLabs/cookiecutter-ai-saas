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
| `dmcaAgent` | Name, postal address, phone and email of your designated copyright (DMCA) agent, exactly as registered with the US Copyright Office (see [Registering a designated agent](#registering-a-designated-agent)). |
| `accessibility.contactEmail` | Where visitors report an accessibility barrier. |
| `accessibility.reviewDate` | When you last reviewed the accessibility statement, as `YYYY-MM-DD`. |
| `consentTextVersion` | The version of the consent text visitors agree to. Changing it invalidates every stored consent, so everyone is asked again; change it whenever you change what you collect. |
{%- if cookiecutter.analytics == "posthog" %}
| `analyticsRetention` | How long analytics events are kept, in words ("12 months"), as `/legal/analytics` tells visitors. Set your PostHog project's data retention to match (see [Analytics and consent](#analytics-and-consent)). |
{%- endif %}

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

It needs Docker, ports 3000{% if cookiecutter.include_stripe == "yes" %}, 3001{% endif %}{% if cookiecutter.analytics == "posthog" %}, 3996{% endif %}{% if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}, 3997{% endif %}{% if cookiecutter.include_stripe == "yes" %}, 3998{% endif %} and 3999 free,
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
- a completed subscription checkout sends the subscriber exactly one
  acknowledgment email with the same terms and how to cancel, even when
  Stripe delivers the event twice, and one whose send fails goes out when
  Stripe redelivers the event; a one-time purchase sends none, and
  without Resend configured the webhook still succeeds and sends nothing;
{%- endif %}
{%- if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}
- a signed unsubscribe link shows a confirmation page, and both that page's
  form and an email app's one-click request suppress the address; a
  tampered link is refused and repeating a request changes nothing; and,
  against a stand-in Resend API, `sendMarketingEmail` refuses to send with a
  placeholder postal address, skips suppressed recipients and sends every
  other message with the footer and both unsubscribe headers (see
  [Marketing email](#marketing-email-can-spam));
{%- endif %}
{%- if cookiecutter.analytics == "posthog" %}
- no analytics request is made, by the browser or by the app's `/ingest`
  proxy, before the visitor has chosen, after "Reject", when the browser
  sends a Global Privacy Control signal, or when the only consent on record
  was given to an older consent text; after "Accept" one is made, through
  `/ingest` only and without the visitor's cookies or IP address; "Accept"
  and "Reject" look exactly alike; withdrawing consent on
  `/legal/analytics` stops it and clears PostHog's cookies and storage; and
  "Privacy choices" in the footer asks again, against a stand-in PostHog
  (see [Analytics and consent](#analytics-and-consent));
{%- endif %}
- the home page, the sign-in and sign-up pages, the other public pages, the
  blog (when the project has one), every legal page and the dashboard make
  no request to another server;
- the copyright page shows every detail of the configured DMCA agent, and
  the Terms of Service link to it (see [Copyright](#copyright-dmca));
- the home page, the sign-in page, the sign-up page in each of its states
  (age screen, with an error, passed, turned away), the Privacy Policy and
  Terms, every legal page, the dashboard and the account settings pass an
  automated WCAG 2.2 AA audit in both the light and the dark theme, open
  with a working "Skip to content" link, and show a clearly visible focus
  outline on everything the keyboard can reach{% if cookiecutter.analytics == "posthog" %}, all with the analytics
  consent banner showing; and the banner can be answered with Enter or Space
  alone, and Tab moves on past it{% endif %}.

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
{% if cookiecutter.include_stripe == "yes" -%}
- **Payments don't make accounts.** The Stripe webhook fulfils a checkout
  only for an existing account, found by the app's reference id or, for a
  checkout started elsewhere (a Stripe Payment Link, say), the customer's
  email. A paid checkout from someone without an account is not fulfilled:
  it is logged as `[Webhook] no account for checkout session …` with the
  session and customer ids, never the email.
{% endif -%}
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
{% if cookiecutter.include_stripe == "yes" -%}
- Reconcile unfulfilled checkouts. Watch your logs for `no account for
  checkout session`, look the session up in the Stripe Dashboard, and either
  refund it or ask the customer to sign up with the email they paid with and
  then resend the event from the Dashboard so the webhook fulfils it.
{% endif -%}
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
- **Never subscribed twice.** Each user checks out as their own Stripe
  customer, created and stored before their first checkout
  (`lib/checkout.ts`), so the billing portal shows their whole history. A
  user whose subscription isn't cancelled who starts another subscription
  checkout, from the settings or from the checkout the app opens after
  sign-up, is sent to the billing portal to change plan instead. A
  checkout requested while another for the same user is under way (a
  double-submitted form) is turned away, and a repeated one leaves only the
  newest payable.
  `tests/billing/integration/checkout.test.mjs` proves this against a
  running app (`scripts/check_billing.sh`).
- **The acknowledgment.** When Resend is configured (`RESEND_API_KEY`), the
  Stripe webhook emails every new subscriber once, on
  `checkout.session.completed`, from `config.resend.fromNoReply`
  (`lib/subscription-acknowledgment.ts`): the same renewal terms, word for
  word, and step-by-step how to cancel online through Settings → Manage
  billing and the billing portal, with a link to `/legal/subscriptions`. A
  redelivered event sends nothing more, and a one-time purchase sends
  nothing. Without `RESEND_API_KEY` the app sends nothing; see below. A
  send that fails (Resend down, domain not verified) is logged as
  `Subscription acknowledgment send failed for <subscription id>` and the
  webhook answers the event with a 500, so Stripe redelivers it (in live
  mode, Stripe keeps retrying for up to three days) and the redelivery
  sends it. Each send carries a Resend idempotency key for the
  subscription, so deliveries that overlap still send one email. If the
  retries run out, the log line is the last word: fix Resend, then resend
  that subscription's `checkout.session.completed` event from the Stripe
  Dashboard.
- **One subscription, one row.** `subscriptions.stripe_subscription_id` is
  unique, so a redelivered event finds the row it recorded rather than
  adding another, and `subscriptions.acknowledged_at` records when the
  acknowledgment went out (null until then, and always without Resend).
  On an existing deployment, remove any duplicate rows before applying the
  schema change (`npm run db:push` or your migration), or it will fail.
  This keeps the oldest row for each subscription:
  `delete from subscriptions a using subscriptions b where a.stripe_subscription_id = b.stripe_subscription_id and (a.created_at, a.id) > (b.created_at, b.id);`
  Subscriptions recorded before the column existed start out null, so
  resending one of their old events from the Dashboard sends another
  acknowledgment.
- **The notice.** `/legal/subscriptions` explains renewal, cancellation and
  refunds and lists each plan's terms; the Terms of Service have a
  "Payment and Automatic Renewal" section linking to it.
- The compliance check reads the plans out of `config.ts` and proves, in a
  real browser against the running app, that every subscribe button has the
  right terms beside it and that each Checkout Session the app creates
  carries them and requires consent. The app's Stripe client is pointed at a
  stand-in API for that (`tests/compliance/fake-stripe.mjs`, through
  `STRIPE_API_BASE`, which you leave unset). It also posts signed
  `checkout.session.completed` events to the webhook and reads the emails
  the app sends from a stand-in Resend API (`tests/compliance/fake-resend.mjs`,
  through `RESEND_BASE_URL`, which you also leave unset), and starts a
  second copy of the app without `RESEND_API_KEY` to prove it then sends
  nothing.

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
  is false. Turn on switching plans (add every plan's product) and updating
  the payment method there too: a subscriber who picks another plan in the
  app is sent to the portal to make the change. Don't add a step that
  makes cancelling harder than subscribing, such as a required call or
  chat.
- Sell subscriptions only through the app's own checkout, not a Stripe
  Payment Link, pricing table or Buy Button. Those make a Stripe customer
  of their own, so an existing user who pays through one has two, and the
  billing portal the app opens, as their own customer, won't show that
  subscription or let them cancel it there. The webhook still grants the
  plan, and logs `[Webhook] checkout session … was paid as Stripe customer
  …, not their own …` with the user and both customer ids. When you see it,
  cancel that subscription in the Stripe Dashboard, refunding what's
  unused, and have the user subscribe again from the app; or, if they
  agree, leave it and cancel it for them when they ask.
- Make sure the acknowledgment is sent. Set `RESEND_API_KEY` and verify
  your sending domain in Resend, and the app sends it. If you run without
  Resend, the app sends nothing, so turn on Stripe's own subscription
  confirmation emails instead: in the Stripe Dashboard, turn on emails to
  customers for successful payments (Settings → Customer emails) and for
  subscriptions (Settings → Billing → Subscriptions and emails), and add the
  renewal terms and how to cancel (Settings → Manage billing, then cancel in
  the billing portal) to what Stripe sends, for example in the default
  invoice footer (Settings → Billing → Invoice template), since its standard
  receipt says neither. Either way, buy a test subscription and read what
  arrives.
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
{% if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" -%}
## Marketing email (CAN-SPAM)

**The law and the risk.** The US CAN-SPAM Act (15 U.S.C. 7701–7713, and the
FTC's CAN-SPAM Rule, 16 CFR Part 316) covers every commercial email, one
whose main purpose is to advertise or promote a product or service, sent to
anyone, not only bulk mail. Each one must not use false or misleading
header information or a deceptive subject line, must identify itself as an
advertisement (unless the recipient asked for it), must give the sender's
valid physical postal address, and must offer a working way to opt out that
needs nothing more than a reply or a visit to one web page, keeps working
for at least 30 days after sending, and is honoured within 10 business
days. Once someone opts out, you may not email them marketing again or sell
or transfer their address. The FTC enforces it with civil penalties of up
to $53,088 per email (16 CFR 1.98), and the business is liable even when a
contractor sends the mail. Separately, Gmail and Yahoo have required bulk
senders since February 2024 to support one-click unsubscribe (RFC 8058) and
to honour it within two days. As of October 2026.

Transactional and relationship email (sign-in links, replies to the contact
form, billing and account notices) is outside most of these rules, as long
as it isn't dressed up as an advertisement.

The app used to send only transactional email, and had no unsubscribe or
suppression mechanism for anything else.

**What the app does.**

- **One way to send marketing.** `sendMarketingEmail` in
  `lib/marketing-email.ts` is the only supported way to send commercial
  email. It takes a recipient, a subject, a sender name and a body, and:
  1. refuses to send at all while `legal.marketingPostalAddress` is still a
     `REPLACE_WITH_...` placeholder;
  2. skips a recipient who has opted out;
  3. adds a footer with an unsubscribe link and your postal address;
  4. sets the `List-Unsubscribe` header (the unsubscribe URL and a
     `mailto:`) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so
     email apps show their own unsubscribe button;
  5. sends through Resend.
- **Opt-outs outlive accounts.** The `email_suppressions` table holds each
  opted-out address, normalised, with when and how it opted out. It is
  separate from `users`, so deleting an account doesn't undo an opt-out, and
  signing up again with the same address doesn't either.
- **Links that keep working.** Each unsubscribe link carries a token signed
  with HMAC using `NEXTAUTH_SECRET`. It doesn't expire, so the link in a
  years-old email still works; a token that has been tampered with is
  refused. Rotating `NEXTAUTH_SECRET` breaks every link already sent.
- **Unsubscribing takes one step.** Opening the link shows a page with a
  single button to confirm, which works without JavaScript and without
  signing in. The same address also accepts the one-click `POST` that email
  apps send. Either way the address is suppressed at once, doing it twice
  changes nothing, and the response never says whether the address has an
  account.
- **Transactional email is untouched.** Whichever of magic-link sign-in,
  the contact form and the subscription acknowledgment this project has
  still send directly through Resend and ignore suppressions.
- **A notice.** `/legal/email-preferences` explains which emails are
  marketing and which are transactional, and how to opt out; the Privacy
  Policy links to it.

Sending a newsletter:

```ts
import { sendMarketingEmail } from "@/lib/marketing-email";

for (const user of subscribers) {
  await sendMarketingEmail({
    to: user.email,
    subject: "What's new in {{ cookiecutter.project_name }} this month",
    senderName: "{{ cookiecutter.project_name }}",
    body: "Here is what we shipped this month…",
  });
}
```

**What you still have to do.**

- Set `legal.marketingPostalAddress` in `config.ts`. Until you do, the
  module refuses to send anything. It must be a valid physical postal
  address where you can receive mail: your business's street address, a PO
  box registered with the US Postal Service, or a private mailbox at a
  commercial mail receiving agency (a UPS Store mailbox, or a virtual
  mailbox service that is a registered CMRA), registered under Postal
  Service rules (USPS Form 1583). If you don't want to publish your home
  address, rent a PO box or a CMRA mailbox.
- Send every commercial email through `sendMarketingEmail`. A message sent
  any other way, from your own code, a Resend broadcast or another email
  tool, gets no footer, no headers and no suppression check. If you use a
  separate email-marketing service, import `email_suppressions` into it
  and keep the two in sync.
- Write honest messages. The module can't check that the subject line
  matches the content, or that the email says it is an advertisement; say
  so clearly in the body unless the recipient asked to receive it.
- Use a sending address on a domain you have verified in Resend, and a
  sender name that says who you are.
- Serve the app over `https` and set `NEXTAUTH_URL` to its `https://`
  address. The unsubscribe links are built from it, and email apps only
  offer one-click unsubscribe for an `https` link (RFC 8058).
- Act on emailed unsubscribe requests. The `mailto:` in the
  `List-Unsubscribe` header sends them to `resend.supportEmail` with the
  subject "unsubscribe"; nothing reads that mailbox for you, so add each
  sender to `email_suppressions` by hand (or with a script) within 10
  business days.
- Keep `NEXTAUTH_SECRET` stable. Changing it invalidates every unsubscribe link
  in email already sent, which can break the 30-day rule.
- Don't sell, rent or hand over the addresses of people who opted out, and
  never delete rows from `email_suppressions` to "clean" the list.
- Outside the US, consent comes first: the EU and UK (the ePrivacy rules and
  PECR) and Canada (CASL) generally require opt-in consent before marketing
  email, which this module does not record.

{% endif -%}
## Analytics and consent

{% if cookiecutter.analytics == "posthog" -%}
**The law and the risk.** In the EU, the ePrivacy Directive (Article 5(3),
as each member state has enacted it) and in the UK, PECR (regulation 6)
allow storing or reading anything on a visitor's device, a cookie or a
localStorage key alike, only with their prior consent, unless it is
strictly necessary for a service they asked for. Analytics is not. The
consent has to meet the GDPR's standard (Articles 4(11) and 7): freely
given, specific, informed and unambiguous, given before anything is
stored, as easy to withdraw as to give, and something you can show you
obtained. Regulators also require refusing to be as easy as accepting:
France's CNIL fined Google €150 million and Facebook €60 million, in
decisions announced in January 2022, for cookie banners that took one click
to accept and several to refuse. GDPR fines reach €20 million or 4% of worldwide annual
turnover, whichever is higher (Article 83(5)). In California, the CCPA
requires honouring a Global Privacy Control signal as an opt-out of
"selling" or "sharing" personal information (Cal. Code Regs. tit. 11,
§7025), which sending browsing data to an analytics company can amount to;
the Attorney General's 2022 settlement with Sephora, for $1.2 million, was
partly for ignoring it. Civil penalties are up to $2,500 per violation, or
$7,500 if intentional, adjusted for inflation (Civil Code §1798.155 and
§1798.199.90). Colorado and other states require honouring GPC too. As of
October 2026.

**What the app does.**

- **One module decides.** `lib/consent.ts` is the only code that reads or
  writes the consent cookie. Anything that tracks asks it
  `mayRun("analytics")` (or `useConsent("analytics")` in a component) and
  does nothing without an explicit, current "yes". The choice is stored in
  a first-party cookie, `consent`, as JSON with the consent text version:
  `{"version":"<legal.consentTextVersion>","analytics":"granted"}`. It
  lasts six months, after which the visitor is asked again.
- **The banner.** Until the visitor chooses, every page shows a banner at
  the top (`components/consent/consent-banner.tsx`) with "Accept" and
  "Reject" buttons that look exactly alike and a link to
  `/legal/analytics`. It is not a dialog: it sits in the page's normal
  flow, covers nothing, and the site works fully without an answer (no
  answer means no analytics). It is reached by Tab in order, answered with
  Enter or Space, and Tab moves on past it.
- **Nothing before consent.** PostHog's library (`posthog-js`) is a
  separate chunk that `lib/analytics.ts` loads with a dynamic `import()`
  only after "Accept". Before that, the page has none of PostHog's code
  and stores nothing.
- **A first-party proxy.** posthog-js sends everything to `/ingest` on the
  app's own domain. `app/ingest/[...path]/route.ts` forwards it to
  `POSTHOG_HOST` (and `/ingest/static/*` to `POSTHOG_ASSETS_HOST`), passing
  on only the content type, encoding and user agent: never the visitor's
  cookies, and none of the headers that carry their IP address
  (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, ...). PostHog sees your
  server's address instead. `$ip` is also on posthog-js's property
  denylist. So the visitor's browser never contacts PostHog, and the
  no-off-origin rule (see [Fonts and third-party
  requests](#fonts-and-third-party-requests)) still holds with analytics
  on.
- **Page views only.** It records page views (including Next.js's
  client-side navigations) and page leaves. Autocapture, session
  recording, heatmaps, dead clicks, web vitals, exception capture,
  surveys, feature flags and web experiments are all off, and posthog-js
  may not load any further script. Events are sent as they happen, not
  queued, and every event asks `lib/consent.ts` again on its way out.
  Users are not identified, so events are not linked to accounts.
- **GPC is a refusal.** A browser that sends a Global Privacy Control
  signal (`navigator.globalPrivacyControl`) is treated as having chosen
  "Reject", whatever the cookie says: no banner, nothing loaded.
- **Withdrawing is as easy as giving.** "Privacy choices" in the footer
  shows the banner again, and `/legal/analytics` has "Turn analytics on"
  and "Turn analytics off" buttons. Turning it off opts posthog-js out,
  stops it storing anything, and deletes every PostHog cookie and
  localStorage and sessionStorage key (`ph_...`, `__ph_...`) at once.
- **Asking again.** A cookie written against a different
  `legal.consentTextVersion` counts as no choice, so changing it puts the
  banner in front of everyone again.
- **The key is read at request time.** `POSTHOG_KEY` is read on the server
  as each page is rendered, not built into the client bundle, so one Docker
  image runs with or without analytics. Unset, there is no banner, no
  "Privacy choices" link and nothing loads. The cost: every page is
  rendered on request rather than prerendered at build time.
- **The notice.** `/legal/analytics` says what is collected, that PostHog
  processes it for you, for how long (`legal.analyticsRetention`), how GPC
  is treated and how to change your mind. The Privacy Policy links to it.
- The compliance check runs the app against a stand-in PostHog
  (`tests/compliance/fake-posthog.mjs`, through `POSTHOG_HOST` and
  `POSTHOG_ASSETS_HOST`) and proves every point above in a real browser,
  watching both the browser's requests and what reaches the stand-in.

**Configuring it.**

1. Create a PostHog project, in the US or the EU cloud. Choose the EU one
   if most of your visitors are in the EU.
2. Copy the project API key (it starts `phc_`) from the project's settings
   into `POSTHOG_KEY`: in `.env.local` for development, and as
   `vault_posthog_key` in `ansible/vault.yml` for production. It is not a
   secret, since every visitor who accepts receives it.
3. For an EU project, set `POSTHOG_HOST=https://eu.i.posthog.com` and
   `POSTHOG_ASSETS_HOST=https://eu-assets.i.posthog.com` (`posthog_host`
   and `posthog_assets_host` in `ansible/group_vars/all.yml`, which
   `env-production.j2` reads). The defaults are the US cloud's.
4. In the PostHog project's settings, turn on "Discard client IP data",
   and set the data retention to what `legal.analyticsRetention` in
   `config.ts` says.
5. Accept PostHog's data processing agreement (DPA), so it processes the
   data as your processor.
6. Set `legal.consentTextVersion` and `legal.analyticsRetention`, deploy,
   and check the banner, `/legal/analytics` and an event arriving in
   PostHog.

**Changing what you collect.** Whenever you change what is measured, who
receives it or how long it is kept, update `/legal/analytics` (and the
Privacy Policy if it is affected) and change `legal.consentTextVersion`,
for example from `"2026-10"` to `"2026-11"`. Everyone who accepted the old
text is asked again; nothing runs for them until they answer. Don't change
the version for a typo fix: that asks everyone again for nothing.

**Tracking an event.** Page views are automatic. For anything else, call
`trackEvent` from `lib/analytics.ts` in client code; it does nothing unless
the visitor accepted and PostHog is running, so call it freely:

```ts
import { trackEvent } from "@/lib/analytics";

trackEvent("report exported", { format: "pdf" });
```

Never put personal data (names, email addresses, free text a user typed)
in an event's properties.

### Adding another purpose

Anything new that tracks visitors, stores something on their device that
isn't strictly necessary, or loads another company's code (a chat widget,
an embedded video, ads, another analytics tool) needs its own consent.

1. Add the purpose to `Purpose` in `lib/consent.ts`, for example
   `"analytics" | "support-chat"`. Nothing else in that file changes: the
   cookie keeps one answer per purpose.
2. Ask for it: add its own question, with its own equally prominent
   "Accept" and "Reject", to the banner, and its own controls next to
   `AnalyticsChoices` on its `/legal` page. Don't bundle it with
   analytics; consent has to be specific.
3. Gate the code on it: load it only after `mayRun("support-chat")` (or
   `useConsent("support-chat")`) is true, with a dynamic `import()` or by
   rendering the component only then, and stop it and clear what it stored
   when the answer turns to "denied".
4. Route it through your own domain where you can, as `/ingest` does, so
   the browser never contacts the other company.
5. Describe it on a `/legal` page, change `legal.consentTextVersion`, and
   add a test to `tests/compliance/` that proves nothing is sent before
   consent or after "Reject".

**What you still have to do.**

- Do steps 4 and 5 of [Configuring it](#analytics-and-consent): discard IP
  data, set the retention, and accept PostHog's DPA. EU data sent to the US
  cloud also needs a transfer mechanism (PostHog relies on the EU-US Data
  Privacy Framework and standard contractual clauses); the EU cloud avoids
  the question.
- Keep `/legal/analytics` true. If you turn on autocapture, session
  recording, surveys or feature flags, call `posthog.identify` to link
  events to accounts, or send personal data in events, say so there and
  change `legal.consentTextVersion`. Session recording in particular needs
  its own consent and masking of everything a visitor types.
- Keep every tracker behind `lib/consent.ts`. A script pasted into a
  layout, a PostHog snippet copied from its docs, or a second analytics
  tool would run before consent; the third-party request check catches
  some, not all, of these.
- Be able to show consent. The cookie is the record on the visitor's side;
  the app keeps no server-side log of who consented. If you need one (a
  regulator can ask you to demonstrate consent), log the choice and its
  consent text version, without anything that identifies the visitor
  beyond what you already hold.
- Don't make the site depend on an answer: no "accept to continue" walls,
  and no features that only work after "Accept" unless they truly need
  analytics.
{%- else -%}
**The law and the risk.** In the EU and the UK, storing or reading
anything on a visitor's device that isn't strictly necessary, such as an
analytics cookie, needs their prior consent (the ePrivacy Directive,
Article 5(3), and PECR), given to the GDPR's standard and as easy to refuse
as to accept. In California, a Global Privacy Control signal from the
browser has to be honoured as an opt-out. As of October 2026.

**What the app does.** This project was generated without analytics
(`analytics=none`). Nothing is tracked: there is no analytics library, no
consent banner and no session recording, and `/legal/analytics` tells
visitors so.

**What you still have to do.**

- To add analytics, regenerate the project with `analytics=posthog` and
  carry your changes across, or copy what it adds: `lib/consent.ts`,
  `lib/analytics.ts`, `components/consent/`, the `/ingest` proxy and its
  tests. It ships PostHog behind a consent banner, a first-party proxy,
  GPC handling and withdrawal, with compliance tests for each.
- If you add any other tracker yourself, ask for consent before it runs,
  make refusing as easy as accepting, treat GPC as a refusal, and update
  `/legal/analytics`.
{%- endif %}

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
  widgets, embedded videos, maps) only after the visitor consents to it{% if cookiecutter.analytics == "posthog" %}:
  ask `lib/consent.ts` first, as `lib/analytics.ts` does (see
  [Adding another purpose](#adding-another-purpose)){% endif %}.
- When you add a public page, add it to the list in
  `tests/compliance/third-party-requests.test.mjs` so it is checked too.
- Run `scripts/check_compliance.sh` after changing a layout, a page's
  `<head>` or a third-party integration.

## Copyright (DMCA)

**The law and the risk.** When a service stores material at a user's
direction, and that material infringes someone's copyright, the service can
be held liable for it. The Digital Millennium Copyright Act's safe harbor
(17 U.S.C. §512(c)) protects a service provider from money damages for
infringing material its users store, but only if it has designated an
agent to receive takedown notices, registered that agent with the US
Copyright Office and published the agent's details on its site
(§512(c)(2)); removes or disables material promptly once it receives a
valid notice; and has adopted, published and reasonably carried out a
policy of terminating repeat infringers' accounts (§512(i)). Without the
safe harbor, a copyright owner can claim statutory damages of $750 to
$30,000 per work infringed, and up to $150,000 per work when the
infringement is wilful (17 U.S.C. §504(c)), plus attorney's fees. As of
October 2026.

The template has no user uploads today: nothing a visitor writes is stored
and shown to anyone else. The safe harbor starts to matter the moment you
add user content of any kind, such as file uploads, comments, profiles,
shared reports or anything else one user publishes to others. Register
your agent before that ships, not after the first notice arrives; a
designation only protects you from the day it is registered.

**What the app does.**

- **A copyright page.** `/legal/copyright` names your designated agent and
  gives their postal address, phone number and email, all from
  `legal.dmcaAgent` in `config.ts`. It lists what a valid takedown notice
  has to contain (§512(c)(3)), explains how the person whose material was
  removed can send a counter-notice and what happens next (§512(g)), and
  states the repeat-infringer policy.
- **The Terms of Service.** The Terms have a copyright section that states
  the repeat-infringer policy and links to `/legal/copyright`.
- **It is checked.** The compliance check loads `/legal/copyright` and
  fails unless it shows every one of the configured agent's details, and
  fails unless the Terms link to it.

**What you still have to do.**

- Register a designated agent with the US Copyright Office (below) before
  you launch any feature that lets users publish content, and copy the
  agent's details into `legal.dmcaAgent` exactly as registered.
- Renew the designation every 3 years, and amend it whenever any of the
  details change (below).
- Have a way to act on notices. The app has no takedown tooling: when a
  notice arrives, check it has everything the page lists, remove or
  disable the material promptly, tell the user who posted it, and keep a
  record. A notice that identifies the work, the material and the sender
  but misses something else still obliges you to contact the sender
  promptly to help complete it (§512(c)(3)(B)(ii)). On a valid
  counter-notice, promptly send the complainant a copy and tell them you
  will restore the material in 10 business days (§512(g)(2)(B)), then
  restore it in 10 to 14 business days unless they tell you they have
  filed a lawsuit.
- Actually apply the repeat-infringer policy: keep a record of the notices
  against each account, and close accounts that the policy says to close.
  The page defines a repeat infringer as an account with more than one
  valid notice not answered by a successful counter-notice; the safe harbor
  needs you to carry out whatever policy you publish (§512(i)), so change
  that definition to one you will really enforce.
- Keep the page true. If you change how you handle notices or the policy,
  change `/legal/copyright` and the Terms with it.

### Registering a designated agent

The Copyright Office keeps a public online directory of designated agents,
the DMCA Designated Agent Directory. Registration is online only; the
Office no longer accepts paper designations. The rules are in 37 CFR
201.38, and the Office's own walkthroughs and FAQ are at
<https://www.copyright.gov/dmca-directory/>.

1. **Create an account.** Go to <https://dmca.copyright.gov/login.html>
   and register a user account. The account records a primary contact at
   your business for the Office's messages to you, and the Office strongly
   recommends adding a secondary contact, who must be a different person.
   These contacts are not published.
2. **Add the service provider.** Choose "Add Service Provider" and give
   your business's full legal name and its physical street address. A PO
   box is not allowed here without the Office's prior approval. Each
   separate legal entity (a parent and its subsidiary, say) is a separate
   service provider with its own designation.
3. **List alternate names.** Add every name the public might search for
   you under: trading names, the app's name, its domain and URL
   (`{{ cookiecutter.domain_name }}`), and the names of any mobile or
   desktop apps.
4. **Enter the designated agent.** The agent can be a person ("Jane Doe"),
   a position ("Copyright Agent"), a department, or a third-party takedown
   service. Give the agent's postal address, phone number and email
   address; these are published. Unlike the service provider's address, the
   agent's address may be a PO box, so you don't have to publish a home
   address.
5. **Certify and pay.** Read and accept the attestation, then pay through
   Pay.gov by debit or credit card or from a bank account (ACH). The fee is
   $6 per designation. A card payment clears within minutes, ACH within
   three business days; the designation is registered and appears in the
   public directory once payment clears, and the Office emails you to
   confirm.
6. **Copy the details into the app.** Set `legal.dmcaAgent.name`,
   `postalAddress`, `phone` and `email` in `config.ts` to exactly what you
   registered, deploy, and check that `/legal/copyright` shows them.

**Renewing every 3 years.** A designation expires and becomes invalid 3
years after it was registered or last renewed, and an expired designation
loses you the safe harbor. Any amendment renews it, and if nothing has
changed you renew by resubmitting it without changes; each amendment or
resubmission costs $6 and restarts the 3 years. The system emails your
account's contacts 90, 60 and 30 days and one week before the deadline,
but put the date in your own calendar too, in case the contact has moved
on. Whenever you amend the designation (a new agent, address, phone or
email), update `legal.dmcaAgent` and deploy the same day, so the page and
the directory always agree.

The fee, the 3-year term and the reminder emails are as the Copyright
Office's DMCA Designated Agent Directory FAQ and its "Designating an Agent"
tutorial describe them (37 CFR 201.38). As of October 2026.

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
{%- if cookiecutter.analytics == "posthog" %}
- The analytics consent banner sits in the page's normal flow, just after
  the skip link, so it never covers anything and needs no answer before the
  page can be used. The check answers it with the keyboard alone and fails
  if Tab cannot move on past it.
{%- endif %}
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
