#!/usr/bin/env bash
# Prove what docs/compliance.md says this app does, against a really running
# instance of it in a real headless Chrome — not mocks, and not components
# rendered in-process. See tests/compliance/*.test.mjs for what is asserted and
# why; this script is only the plumbing that gets a real server and a real
# Postgres in front of them.
#
# Usage: scripts/check_compliance.sh [test file ...]
#
# With no arguments it runs every tests/compliance/*.test.mjs; name files to
# run only those (CI reruns the age gate this way with the minimum age raised).
#
# scripts/lib/running_app.sh boots the app: postgres and redis come up via
# docker-compose.yml and the app runs as a plain background `next start`.
# Signed-in pages are reached with a session cookie the tests mint
# themselves, and the tests talk to Postgres directly.
#
# Needs Docker, ports 3000{% if cookiecutter.include_stripe == "yes" %}, 3001{% endif %}{% if cookiecutter.analytics == "posthog" %}, 3996{% endif %}{% if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}, 3997{% endif %}{% if cookiecutter.include_stripe == "yes" %}, 3998{% endif %} and 3999
# free, and a Chrome or Chromium binary (set CHROME_PATH if it is not in a
# usual place; see tests/compliance/support.mjs).
#
# Meant for a fresh checkout or CI, not your working copy: it rewrites
# .env.local, so it refuses to run when one exists, and it tears the compose
# stack down WITH its volumes when it finishes.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/running_app.sh
source scripts/lib/running_app.sh
running_app_prepare

# The age-gate{% if cookiecutter.auth_providers != "google_only" %} and account-linking{% endif %} tests sign in through Google and
# Microsoft by way of a fake identity provider they run on this port
# (tests/compliance/fake-oidc.mjs); the issuer overrides point the app's
# providers at it instead of the real ones. Unused providers' settings are
# harmless.
FAKE_OIDC_PORT=3999
FAKE_OIDC="http://localhost:${FAKE_OIDC_PORT}"
{%- if cookiecutter.include_stripe == "yes" %}
# The renewal-terms tests see which Stripe Checkout Sessions the app creates
# by way of a fake Stripe API they run on this port
# (tests/compliance/fake-stripe.mjs); STRIPE_API_BASE points the app's Stripe
# client at it. The secret key is a placeholder that only has to be present.
FAKE_STRIPE_PORT=3998
# The acknowledgment tests sign the webhook events they post with this
# placeholder, read every email the app sends by way of a fake Resend API on
# FAKE_RESEND_PORT (below; RESEND_BASE_URL points the app's Resend client at
# it), and start a second copy of the app on NO_RESEND_APP_PORT with Resend
# unconfigured.
STRIPE_WEBHOOK_SECRET="whsec_0000000000000000000000000000000000000000"
NO_RESEND_APP_PORT=3001
{%- endif %}
{%- if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}
# The fake Resend API (tests/compliance/fake-resend.mjs) listens here. The
# marketing-email tests load lib/marketing-email.ts themselves and point it
# here too.
FAKE_RESEND_PORT=3997
{%- endif %}
{%- if cookiecutter.analytics == "posthog" %}
# The analytics-consent tests see what the app's first-party proxy (/ingest)
# forwards to PostHog by way of a fake PostHog they run on this port
# (tests/compliance/fake-posthog.mjs); POSTHOG_HOST and POSTHOG_ASSETS_HOST
# point the proxy at it. The project key is a placeholder that only has to be
# present: without one the app shows no consent banner and loads nothing.
FAKE_POSTHOG_PORT=3996
{%- endif %}

running_app_write_env <<ENV
REDIS_URL=${REDIS_URL}
GOOGLE_ID=compliance-test
GOOGLE_SECRET=compliance-test
AUTH_GOOGLE_ISSUER=${FAKE_OIDC}/google
MICROSOFT_ENTRA_ID_ID=compliance-test
MICROSOFT_ENTRA_ID_SECRET=compliance-test
AUTH_MICROSOFT_ENTRA_ID_ISSUER=${FAKE_OIDC}/microsoft
{%- if cookiecutter.include_stripe == "yes" %}
STRIPE_SECRET_KEY=sk_test_0000000000000000000000000000000000000000
STRIPE_API_BASE=http://localhost:${FAKE_STRIPE_PORT}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
RESEND_API_KEY=re_test_0000000000000000000000000000
RESEND_BASE_URL=http://localhost:${FAKE_RESEND_PORT}
{%- endif %}
{%- if cookiecutter.analytics == "posthog" %}
POSTHOG_KEY=phc_test0000000000000000000000000000000000000
POSTHOG_HOST=http://localhost:${FAKE_POSTHOG_PORT}
POSTHOG_ASSETS_HOST=http://localhost:${FAKE_POSTHOG_PORT}
{%- endif %}
ENV

running_app_start postgres redis

# One file at a time: the fake services some files start listen on fixed
# ports the app is pointed at, so two files starting the same one at once
# would collide.
if [[ $# -gt 0 ]]; then TESTS=(node --test --test-concurrency=1 "$@"); else TESTS=(npm run test:compliance); fi
# SERVER_LOG lets the age-gate tests check no date of birth was logged{% if cookiecutter.include_stripe == "yes" %},
# and the acknowledgment tests check what an unfulfilled checkout logs{% endif %}.
running_app_test "the compliance tests" env BASE_URL="$BASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" DATABASE_URL="$DATABASE_URL" \
  FAKE_OIDC_PORT="$FAKE_OIDC_PORT" SERVER_LOG="$SERVER_LOG" \
{%- if cookiecutter.include_stripe == "yes" %}
  FAKE_STRIPE_PORT="$FAKE_STRIPE_PORT" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  NO_RESEND_APP_PORT="$NO_RESEND_APP_PORT" \
{%- endif %}
{%- if cookiecutter.include_stripe == "yes" or cookiecutter.include_marketing_extras == "yes" or cookiecutter.include_magic_link == "yes" %}
  FAKE_RESEND_PORT="$FAKE_RESEND_PORT" \
{%- endif %}
{%- if cookiecutter.analytics == "posthog" %}
  FAKE_POSTHOG_PORT="$FAKE_POSTHOG_PORT" \
{%- endif %}
  "${TESTS[@]}"

echo "==> Compliance check passed"
