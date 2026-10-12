// Webhook handler failure integration tests (issue #75) — run against a
// REALLY RUNNING instance of a generated project (scripts/check_billing.sh
// boots one, with include_stripe=yes), its Stripe client pointed at a
// stand-in API (../../compliance/fake-stripe.mjs).
//
// Stripe takes a 2xx as delivered and never sends that event again, so a
// handler that fails on something transient (Stripe or the database
// unreachable) has to answer non-2xx, or the fulfilment is lost for good.
// These tests take the fake Stripe down while an event is delivered, check
// that it is refused and logged and that nothing was granted, then bring
// Stripe back and redeliver the very same event, as Stripe would, to check
// it grants exactly what one successful delivery would. What is refused on
// purpose (a bad signature) or ignored on purpose (an event type the app
// doesn't handle) keeps its own answer.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL, FAKE_STRIPE_PORT; optionally, SERVER_LOG — the app's log
// file, checked for the error the webhook logs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectDb } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import {
  asNewUser,
  assertLogged,
  deliver,
  deliverOk,
  oneTimePurchaseCompleted,
  planOf,
  postWebhookEvent,
  subscriptionCompleted,
  withId,
} from "./support.mjs";

let stripe;
let db;
before(async () => {
  stripe = await startFakeStripe();
  db = await connectDb();
});
after(async () => {
  await stripe?.close();
  await db?.end();
});

/** Deliver `event` while Stripe is down, asserting the webhook asks for a retry. */
async function deliverDuringOutage(event) {
  const end = stripe.outage();
  try {
    const res = await deliver(event);
    assert.ok(res.status >= 500, `a failed ${event.type} should be answered 5xx so Stripe retries it, got ${res.status}`);
  } finally {
    end();
  }
}

async function subscriptionRows(stripeSubscriptionId) {
  const { rows } = await db.query("select plan from subscriptions where stripe_subscription_id = $1", [
    stripeSubscriptionId,
  ]);
  return rows;
}

async function purchaseRows(checkoutSessionId) {
  const { rows } = await db.query("select quantity from purchases where stripe_checkout_session_id = $1", [
    checkoutSessionId,
  ]);
  return rows;
}

async function creditsOf(userId) {
  const { rows } = await db.query("select credits from users where id = $1", [userId]);
  return rows[0]?.credits;
}

test("a subscription checkout that fails while Stripe is down is retried, and its redelivery grants the plan once", async () => {
  await asNewUser(db, async (user) => {
    const event = withId(subscriptionCompleted(stripe, user));
    const { subscription } = event.data.object;

    await deliverDuringOutage(event);
    assertLogged(event.id);
    assert.equal(await planOf(db, user.id), "free", "nothing is granted by a delivery that failed");
    assert.equal((await subscriptionRows(subscription)).length, 0);

    await deliverOk(event);
    assert.equal(await planOf(db, user.id), "pro", "the redelivery grants the plan");
    assert.deepEqual(await subscriptionRows(subscription), [{ plan: "pro" }]);

    await deliverOk(event);
    assert.equal(await planOf(db, user.id), "pro");
    assert.equal((await subscriptionRows(subscription)).length, 1, "a further redelivery records nothing more");
  });
});

test("a one-time purchase that fails while Stripe is down is retried, and its redelivery grants every credit once", async () => {
  await asNewUser(db, async (user) => {
    const event = withId(oneTimePurchaseCompleted(stripe, user, { quantity: 3 }));
    const session = event.data.object.id;

    // The purchase's quantity is only on its line items, which have to be
    // fetched from Stripe: recording it without them would grant the wrong
    // number of credits, and the redelivery couldn't correct it.
    await deliverDuringOutage(event);
    assertLogged(event.id);
    assert.equal((await purchaseRows(session)).length, 0, "nothing is recorded by a delivery that failed");
    assert.equal(await creditsOf(user.id), 0);

    await deliverOk(event);
    assert.deepEqual(await purchaseRows(session), [{ quantity: 3 }]);
    assert.equal(await creditsOf(user.id), 3, "the redelivery grants every credit paid for");

    await deliverOk(event);
    assert.equal(await creditsOf(user.id), 3, "a further redelivery grants nothing more");
  });
});

test("an event with a bad signature is still refused with a 400, granting nothing", async () => {
  await asNewUser(db, async (user) => {
    const event = withId(subscriptionCompleted(stripe, user));
    const res = await postWebhookEvent(JSON.stringify({ object: "event", ...event }), "t=1,v1=not-a-signature");
    assert.equal(res.status, 400);
    assert.equal(await planOf(db, user.id), "free");
  });
});

test("an event type the app doesn't handle is still acknowledged", async () => {
  const res = await deliver({ type: "invoice.created", data: { object: { id: `in_test_${crypto.randomUUID()}`, object: "invoice" } } });
  assert.equal(res.status, 200, `an unhandled event type should be answered 2xx, got ${res.status}`);
});
