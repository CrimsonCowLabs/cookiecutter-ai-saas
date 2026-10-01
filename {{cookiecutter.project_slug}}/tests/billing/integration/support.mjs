// Shared helpers for tests/billing/integration/*.test.mjs — kept separate so
// each test file reads as a list of webhook behaviors, not plumbing. Mirrors
// tests/auth/support.mjs's shape; connectDb/insertTestUser/deleteTestUser are
// generic enough (not auth-specific) to import from there directly rather
// than duplicating them here.
const DEFAULT_BASE_URL = "http://localhost:3000";
// A fixed, low-entropy placeholder, not a real credential — the same idea as
// tests/auth/support.mjs's NEXTAUTH_SECRET. scripts/check_billing.sh sets
// this exact value as the STRIPE_WEBHOOK_SECRET of the server it boots AND
// as the STRIPE_WEBHOOK_SECRET these tests sign fake events with, so the
// default here only has to agree with that script.
const DEFAULT_WEBHOOK_SECRET = "whsec_0000000000000000000000000000000000000000";

export const config = {
  baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET,
};

/** POSTs a pre-signed fake Stripe event straight at the webhook route. */
export async function postWebhookEvent(payload, signature) {
  return fetch(new URL("/api/webhook/stripe", config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });
}
