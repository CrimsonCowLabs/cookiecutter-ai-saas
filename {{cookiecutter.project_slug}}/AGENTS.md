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
- **Every new subscription is acknowledged once.** The Stripe webhook's `checkout.session.completed` handler sends each new subscriber one email through `sendSubscriptionAcknowledgment` (`lib/subscription-acknowledgment.ts`), built from the same `renewalTerms` text plus how to cancel, while `subscriptions.acknowledged_at` is null, then sets it; a failed send answers the event 500 so Stripe redelivers it. Keep the Resend idempotency key, and don't send it for one-time purchases, from anywhere else, or with different terms. `tests/compliance/subscription-acknowledgment.test.mjs` enforces this.
{%- endif %}
{%- if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}
- **Marketing email only through the module.** Any email that advertises or promotes a product or service — newsletters, announcements, offers, re-engagement — is sent through `sendMarketingEmail` (`lib/marketing-email.ts`), never by calling Resend directly. It refuses to send while `config.legal.marketingPostalAddress` is a placeholder, skips addresses in `email_suppressions`, and adds the footer with the unsubscribe link and postal address and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Don't bypass it, don't delete or expire suppression rows (they outlive accounts on purpose), and don't make unsubscribing need a sign-in or reveal whether an address has an account. Transactional email (sign-in links, contact form, billing) stays outside it. `tests/compliance/marketing-email.test.mjs` enforces this.
{%- endif %}
- **WCAG 2.2 AA on every page.** Render each page's content inside `<Main>` from `components/ui/skip-link.tsx`, and add every page you add to the page lists in `tests/compliance/accessibility.test.mjs`, which runs axe-core in both themes and checks the skip link and focus outlines. Don't remove or override the `:focus-visible` ring in `app/globals.css`, and keep muted text at `text-base-content/60` or stronger.
