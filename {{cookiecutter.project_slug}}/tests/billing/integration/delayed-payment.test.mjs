// Delayed payment method webhook integration tests (issue #73) — run against
// a REALLY RUNNING instance of a generated project (scripts/check_billing.sh
// boots one, with include_stripe=yes), its Stripe client pointed at a
// stand-in API (../../compliance/fake-stripe.mjs).
//
// With a bank debit (ACH, SEPA), checkout.session.completed arrives while the
// session's payment_status is still "unpaid"; the money arrives, or fails
// to, days later, as checkout.session.async_payment_succeeded or
// checkout.session.async_payment_failed. Meanwhile Stripe may already count
// the subscription active, with its first invoice still open. Nothing is
// granted until the money has arrived, and no event, however often Stripe
// redelivers it, grants twice.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL, FAKE_STRIPE_PORT.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectDb } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import { asNewUser, deliverOk, planOf, stripeSubscription, subscriptionCompleted } from "./support.mjs";

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

/** The same checkout session as `event`'s, delivered as event `type` with `payment_status`. */
function asEvent(event, type, payment_status) {
  return { type, data: { object: { ...event.data.object, payment_status } } };
}

/** checkout.session.completed for a one-time purchase by `user`, paid by bank debit: not paid yet. */
function oneTimeCompletedUnpaid(user) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${crypto.randomUUID()}`,
        object: "checkout.session",
        mode: "payment",
        client_reference_id: user.id,
        metadata: { type: "one_time_purchase" },
        payment_status: "unpaid",
        amount_total: 1999,
        currency: "usd",
      },
    },
  };
}

/**
 * checkout.session.completed for `user` subscribing by bank debit, not paid
 * yet, as the app's own checkout would be: `user` already has the session's
 * Stripe customer. Stripe counts the subscription active, its first invoice
 * still open.
 */
async function subscriptionCompletedUnpaid(user) {
  const event = subscriptionCompleted(stripe, user);
  const { subscription, customer } = event.data.object;
  await db.query("update users set stripe_customer_id = $2 where id = $1", [user.id, customer]);
  setSubscription(event, { status: "active", firstInvoice: "open" });
  return asEvent(event, "checkout.session.completed", "unpaid");
}

/** Make Stripe's copy of `event`'s subscription be in `status`, its first invoice `firstInvoice`. */
function setSubscription(event, { status, firstInvoice }) {
  const { subscription, customer } = event.data.object;
  stripe.add(stripeSubscription(subscription, { customer, status, firstInvoice }));
}

/** customer.subscription.updated for `event`'s subscription. */
function subscriptionUpdated(event) {
  const { subscription, customer } = event.data.object;
  return { type: "customer.subscription.updated", data: { object: stripeSubscription(subscription, { customer }) } };
}

async function credits(userId) {
  const { rows } = await db.query("select credits from users where id = $1", [userId]);
  return rows[0]?.credits;
}

async function purchases(checkoutSessionId) {
  const { rows } = await db.query("select 1 from purchases where stripe_checkout_session_id = $1", [checkoutSessionId]);
  return rows.length;
}

async function subscriptionRows(stripeSubscriptionId) {
  const { rows } = await db.query("select 1 from subscriptions where stripe_subscription_id = $1", [
    stripeSubscriptionId,
  ]);
  return rows.length;
}

async function failureAudits(checkoutSessionId) {
  const { rows } = await db.query(
    "select user_id from audit_logs where action = 'billing.async_payment_failed' and metadata->>'checkoutSessionId' = $1",
    [checkoutSessionId]
  );
  return rows;
}

test("a one-time purchase completing unpaid grants no credits until async_payment_succeeded, then exactly once", async () => {
  await asNewUser(db, async (user) => {
    const completed = oneTimeCompletedUnpaid(user);
    const sessionId = completed.data.object.id;

    await deliverOk(completed);
    assert.equal(await credits(user.id), 0, "nothing is granted before the money arrives");
    assert.equal(await purchases(sessionId), 0, "and no purchase is recorded");

    const succeeded = asEvent(completed, "checkout.session.async_payment_succeeded", "paid");
    await deliverOk(succeeded);
    assert.equal(await credits(user.id), 1, "the credits are granted once the payment succeeds");
    assert.equal(await purchases(sessionId), 1);

    await deliverOk(succeeded);
    await deliverOk(completed);
    assert.equal(await credits(user.id), 1, "replaying either event grants nothing more");
    assert.equal(await purchases(sessionId), 1);
  });
});

test("async_payment_succeeded arriving before its checkout.session.completed grants the credits once", async () => {
  await asNewUser(db, async (user) => {
    const completed = oneTimeCompletedUnpaid(user);
    await deliverOk(asEvent(completed, "checkout.session.async_payment_succeeded", "paid"));
    await deliverOk(completed);
    assert.equal(await credits(user.id), 1);
  });
});

test("a subscription checkout completing unpaid grants no plan until the payment succeeds", async () => {
  await asNewUser(db, async (user) => {
    const completed = await subscriptionCompletedUnpaid(user);

    await deliverOk(completed);
    assert.equal(await planOf(db, user.id), "free", "no plan before the money arrives");

    await deliverOk(subscriptionUpdated(completed));
    assert.equal(
      await planOf(db, user.id),
      "free",
      "an update while the debit is processing, though Stripe counts the subscription active, grants nothing either"
    );

    setSubscription(completed, { status: "active", firstInvoice: "paid" });
    const succeeded = asEvent(completed, "checkout.session.async_payment_succeeded", "paid");
    await deliverOk(succeeded);
    assert.equal(await planOf(db, user.id), "pro", "the plan is granted once the payment succeeds");

    await deliverOk(succeeded);
    await deliverOk(completed);
    assert.equal(await subscriptionRows(completed.data.object.subscription), 1, "replays leave one subscription row");
    assert.equal(await planOf(db, user.id), "pro");
  });
});

test("async_payment_failed for a one-time purchase grants nothing and is audited once", async () => {
  await asNewUser(db, async (user) => {
    const completed = oneTimeCompletedUnpaid(user);
    const sessionId = completed.data.object.id;
    await deliverOk(completed);

    const failed = asEvent(completed, "checkout.session.async_payment_failed", "unpaid");
    await deliverOk(failed);
    await deliverOk(failed);
    await deliverOk(completed);

    assert.equal(await credits(user.id), 0, "a failed payment grants nothing");
    assert.equal(await purchases(sessionId), 0);
    const audits = await failureAudits(sessionId);
    assert.equal(audits.length, 1, `the failed payment should be audited once, got ${audits.length}`);
    assert.equal(audits[0].user_id, user.id, "against the user who tried to pay");
  });
});

test("async_payment_failed for a subscription grants no plan and is audited once", async () => {
  await asNewUser(db, async (user) => {
    const completed = await subscriptionCompletedUnpaid(user);
    await deliverOk(completed);

    // The debit failed; Stripe keeps the subscription going, its first
    // invoice open, until it is paid some other way or Stripe gives up.
    setSubscription(completed, { status: "past_due", firstInvoice: "open" });
    const failed = asEvent(completed, "checkout.session.async_payment_failed", "unpaid");
    await deliverOk(failed);
    await deliverOk(failed);
    await deliverOk(subscriptionUpdated(completed));

    assert.equal(await planOf(db, user.id), "free", "a failed payment grants no plan");
    const audits = await failureAudits(completed.data.object.id);
    assert.equal(audits.length, 1, `the failed payment should be audited once, got ${audits.length}`);
    assert.equal(audits[0].user_id, user.id);
  });
});

test("a subscription whose first debit failed grants its plan once its invoice is paid some other way", async () => {
  await asNewUser(db, async (user) => {
    const completed = await subscriptionCompletedUnpaid(user);
    await deliverOk(completed);
    setSubscription(completed, { status: "past_due", firstInvoice: "open" });
    await deliverOk(asEvent(completed, "checkout.session.async_payment_failed", "unpaid"));

    // Paid on Stripe's hosted invoice page: no checkout event says so, only
    // the subscription's own update.
    setSubscription(completed, { status: "active", firstInvoice: "paid" });
    await deliverOk(subscriptionUpdated(completed));
    assert.equal(await planOf(db, user.id), "pro");
  });
});

test("a subscription checkout that needs no payment up front (a free trial) grants its tier at once", async () => {
  await asNewUser(db, async (user) => {
    const event = subscriptionCompleted(stripe, user);
    setSubscription(event, { status: "trialing", firstInvoice: "paid" });

    await deliverOk(asEvent(event, "checkout.session.completed", "no_payment_required"));
    assert.equal(await planOf(db, user.id), "pro");
  });
});
