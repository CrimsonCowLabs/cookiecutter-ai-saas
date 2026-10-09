// Shared helpers for tests/billing/integration/*.test.mjs — kept separate so
// each test file reads as a list of webhook behaviors, not plumbing. Mirrors
// tests/auth/support.mjs's shape; connectDb/insertTestUser/deleteTestUser are
// generic enough (not auth-specific) to import from there directly rather
// than duplicating them here.
import crypto from "node:crypto";
import Stripe from "stripe";

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

// The Price every paid plan resolves to under `next start`, matched as "pro"
// (see ./subscription-lifecycle.test.mjs).
export const RESOLVED_PRICE_ID = "price_REPLACE_WITH_LIVE_PRICE_ID";

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

// Only used to sign events locally; never talks to Stripe.
const signer = new Stripe("sk_test_dummy_key_for_offline_signature_tests");

/** POST `event` to the webhook, signed the way Stripe signs it. */
export function deliver(event) {
  const payload = JSON.stringify({ id: `evt_test_${crypto.randomUUID()}`, object: "event", ...event });
  return postWebhookEvent(payload, signer.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }));
}

/** A subscription as Stripe returns it: one item, on `priceId`, in `status`. */
export function stripeSubscription(id, { customer, status = "active", priceId = RESOLVED_PRICE_ID }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "subscription",
    customer,
    status,
    items: {
      object: "list",
      data: [{ price: { id: priceId }, current_period_start: now, current_period_end: now + 30 * 86_400 }],
    },
  };
}

/**
 * The checkout.session.completed event for `user` subscribing as a Stripe
 * customer of the checkout's own, with the session, customer and
 * subscription it names added to `stripe` (a fake-stripe.mjs instance),
 * since the webhook looks each of them up.
 */
export function subscriptionCompleted(stripe, user) {
  const id = crypto.randomUUID();
  const session = {
    id: `cs_test_${id}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: user.id,
    customer: `cus_test_${id}`,
    subscription: `sub_test_${id}`,
    customer_details: { email: user.email },
  };
  stripe.add(
    { ...session, line_items: { object: "list", data: [{ quantity: 1, price: { id: RESOLVED_PRICE_ID } }] } },
    { id: session.customer, object: "customer", email: user.email },
    stripeSubscription(session.subscription, { customer: session.customer })
  );
  return { type: "checkout.session.completed", data: { object: session } };
}
