// Shared helpers for tests/billing/integration/*.test.mjs — kept separate so
// each test file reads as a list of webhook behaviors, not plumbing. Mirrors
// tests/auth/support.mjs's shape; connectDb/insertTestUser/deleteTestUser are
// generic enough (not auth-specific) to import from there directly rather
// than duplicating them here.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import Stripe from "stripe";
import { insertTestUser, deleteTestUser } from "../../auth/support.mjs";

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

/** `event`, given an id of its own: to find it by, or to deliver it again as the same event. */
export const withId = (event) => ({ id: `evt_test_${crypto.randomUUID()}`, ...event });

/**
 * Assert the app's log has a line naming each of `names`. A no-op unless
 * SERVER_LOG names the log file, as scripts/check_billing.sh sets it.
 */
export function assertLogged(...names) {
  if (!process.env.SERVER_LOG) return;
  const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
  const line = log.split("\n").find((l) => names.every((n) => l.includes(n)));
  assert.ok(line, `the server log should have a line naming ${names.join(", ")}`);
}

/** POST `event` to the webhook, signed the way Stripe signs it. */
export function deliver(event) {
  const payload = JSON.stringify({ id: `evt_test_${crypto.randomUUID()}`, object: "event", ...event });
  return postWebhookEvent(payload, signer.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }));
}

/**
 * A subscription as Stripe returns it: one item, on `priceId`, in `status`.
 * Given `firstInvoice` (an invoice status: "open" while a bank debit is on
 * its way, "paid" once it has arrived), its latest invoice is its first.
 */
export function stripeSubscription(id, { customer, status = "active", priceId = RESOLVED_PRICE_ID, firstInvoice }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "subscription",
    customer,
    status,
    ...(firstInvoice && {
      latest_invoice: { id: `in_${id}`, object: "invoice", billing_reason: "subscription_create", status: firstInvoice },
    }),
    items: {
      object: "list",
      data: [{ price: { id: priceId }, current_period_start: now, current_period_end: now + 30 * 86_400 }],
    },
  };
}

/**
 * The checkout.session.completed event for `user` subscribing, on `priceId`,
 * as a Stripe customer of the checkout's own, with the session, customer and
 * subscription it names added to `stripe` (a fake-stripe.mjs instance),
 * since the webhook looks each of them up.
 */
export function subscriptionCompleted(stripe, user, { priceId = RESOLVED_PRICE_ID } = {}) {
  const id = crypto.randomUUID();
  const session = {
    id: `cs_test_${id}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: user.id,
    customer: `cus_test_${id}`,
    subscription: `sub_test_${id}`,
    customer_details: { email: user.email },
    payment_status: "paid",
  };
  stripe.add(
    { ...session, line_items: { object: "list", data: [{ quantity: 1, price: { id: priceId } }] } },
    { id: session.customer, object: "customer", email: user.email },
    stripeSubscription(session.subscription, { customer: session.customer, priceId })
  );
  return { type: "checkout.session.completed", data: { object: session } };
}

// What one unit of oneTimePurchaseCompleted's purchase costs, in cents.
export const ONE_TIME_UNIT_AMOUNT = 1999;

/**
 * The checkout.session.completed event for `user` buying `quantity` of a
 * one-time purchase, with its session added to `stripe` (a fake-stripe.mjs
 * instance), since the webhook looks it up for its line items.
 */
export function oneTimePurchaseCompleted(stripe, user, { quantity = 1 } = {}) {
  const session = {
    id: `cs_test_${crypto.randomUUID()}`,
    object: "checkout.session",
    mode: "payment",
    client_reference_id: user.id,
    metadata: { type: "one_time_purchase" },
    payment_status: "paid",
    amount_total: ONE_TIME_UNIT_AMOUNT * quantity,
    currency: "usd",
  };
  stripe.add({
    ...session,
    line_items: { object: "list", data: [{ quantity, price: { id: "price_test_one_time" } }] },
  });
  return { type: "checkout.session.completed", data: { object: session } };
}

/** Run `fn(user)` as a freshly inserted user of `db`, deleted again afterwards. */
export async function asNewUser(db, fn) {
  const user = await insertTestUser(db);
  try {
    return await fn(user);
  } finally {
    await deleteTestUser(db, user.id);
  }
}

/** Deliver `event`, asserting the webhook accepted it. */
export async function deliverOk(event) {
  const res = await deliver(event);
  assert.equal(res.status, 200, `the webhook should accept ${event.type}, got ${res.status}`);
}

/** `userId`'s plan, as the rest of the app reads it. */
export async function planOf(db, userId) {
  const { rows } = await db.query("select plan from users where id = $1", [userId]);
  return rows[0]?.plan;
}
