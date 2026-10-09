## Agent skills

### Issue tracker

Issues live as GitHub issues on this repo (the `origin` remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); create them in the repo's label set before relying on them. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Compliance

`docs/compliance.md` is the operator guide to the legal risks this app handles. Each risk is explained to visitors on a page under `/legal`, and `scripts/check_compliance.sh` proves what those pages say against a running app. When a change affects one of those risks, update its `/legal` page and its section of the guide too.

Rules:

- **No off-origin requests before consent.** No page may make the visitor's browser contact another server until the visitor has opted in. Load fonts with `next/font`, self-host assets, and never add a `<link>`, `<script>` or `@import` pointing at another host. `tests/compliance/third-party-requests.test.mjs` enforces this against a running app.
- **Every new account passes the age gate.** Accounts are created only by Auth.js, whose `signIn` callback and `createUser` in `lib/auth.ts` refuse a new account without a passed age check (`lib/age-check.ts`). Don't add another way to insert into `users`, don't loosen that check, and never store, log or put in a cookie or URL the date of birth. `tests/compliance/age-gate.test.mjs` enforces this.
{%- if cookiecutter.include_stripe == "yes" %}
- **Renewal terms beside every subscribe button.** Any button that leads to a subscription checkout is rendered through `WithRenewalTerms` (`components/billing/renewal-terms.tsx`), and every subscription Checkout Session goes through `createCheckout` in `lib/stripe.ts`, which repeats the same terms (`lib/renewal-terms.ts`) and requires terms-of-service consent. Pricing shown anywhere comes from `config.stripe.plans`, never hard-coded. `tests/compliance/renewal-terms.test.mjs` enforces this.
- **One Stripe customer and one live subscription per user.** Start every checkout through `subscriptionCheckout` or `oneTimeCheckout` in `lib/checkout.ts`, never by calling `createCheckout` or `createOneTimeCheckout` directly: it takes a per-user lock (turning away a second checkout while one is under way), creates and stores their Stripe customer once, sends a user who already has a subscription that hasn't ended (anything but `canceled` or `incomplete_expired`) to the billing portal, and expires their other open subscription checkouts. The webhook never overwrites a stored `stripeCustomerId`, and logs a checkout paid as a different customer. `tests/billing/integration/checkout.test.mjs` enforces this.
- **Subscription entitlement follows Stripe.** The webhook's `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted` handlers all record a subscription through `syncSubscription` (`lib/subscription-sync.ts`), which fetches it from Stripe rather than trusting the event, upserts its one row with Stripe's status as is, and derives `users.plan` from the user's subscriptions: `active`, `trialing` and `past_due` grant the tier, every other status means free. The acknowledgment is sent only for a subscription that still grants its tier. Don't write `subscriptions` or `users.plan` from a webhook payload anywhere else. `tests/billing/integration/subscription-lifecycle.test.mjs` enforces this, replayed and out-of-order events included.
- **Every new subscription is acknowledged once.** The Stripe webhook's `checkout.session.completed` handler sends each new subscriber one email through `sendSubscriptionAcknowledgment` (`lib/subscription-acknowledgment.ts`), built from the same `renewalTerms` text plus how to cancel, while `subscriptions.acknowledged_at` is null, then sets it; a failed send answers the event 500 so Stripe redelivers it. Keep the Resend idempotency key, and don't send it for one-time purchases, from anywhere else, or with different terms. `tests/compliance/subscription-acknowledgment.test.mjs` enforces this.
{%- endif %}
{%- if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}
- **Marketing email only through the module.** Any email that advertises or promotes a product or service — newsletters, announcements, offers, re-engagement — is sent through `sendMarketingEmail` (`lib/marketing-email.ts`), never by calling Resend directly. It refuses to send while `config.legal.marketingPostalAddress` is a placeholder, skips addresses in `email_suppressions`, and adds the footer with the unsubscribe link and postal address and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Don't bypass it, don't delete or expire suppression rows (they outlive accounts on purpose), and don't make unsubscribing need a sign-in or reveal whether an address has an account. Transactional email (sign-in links, contact form, billing) stays outside it. `tests/compliance/marketing-email.test.mjs` enforces this.
{%- endif %}
{%- if cookiecutter.analytics == "posthog" %}
- **Only lib/consent.ts reads consent; anything that tracks must ask it.** Analytics, and anything else that tracks visitors, stores non-essential data on their device or loads another company's code, runs only once `mayRun(purpose)` (or `useConsent(purpose)`) from `lib/consent.ts` says "granted". Nothing else reads or writes the `consent` cookie. PostHog is loaded only by `lib/analytics.ts`, with a dynamic `import()` after consent, and talks only to the `/ingest` proxy (`app/ingest/[...path]/route.ts`), which must never forward cookies or client-IP headers. Keep "Accept" and "Reject" equally prominent, treat a Global Privacy Control signal as a refusal, and change `legal.consentTextVersion` whenever what is collected changes. `tests/compliance/analytics-consent.test.mjs` enforces this.
{%- endif %}
- **WCAG 2.2 AA on every page.** Render each page's content inside `<Main>` from `components/ui/skip-link.tsx`, and add every page you add to the page lists in `tests/compliance/accessibility.test.mjs`, which runs axe-core in both themes and checks the skip link and focus outlines. Don't remove or override the `:focus-visible` ring in `app/globals.css`, and keep muted text at `text-base-content/60` or stronger.
