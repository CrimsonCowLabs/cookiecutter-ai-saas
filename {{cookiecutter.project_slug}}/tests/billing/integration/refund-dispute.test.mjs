// Refund and dispute webhook integration tests (issue #76) — run against a
// REALLY RUNNING instance of a generated project (scripts/check_billing.sh
// boots one, with include_stripe=yes), its Stripe client pointed at a
// stand-in API (../../compliance/fake-stripe.mjs).
//
// charge.refunded, charge.dispute.created and charge.dispute.closed are each
// recorded in the audit log against the purchase or subscription the charge
// paid for, once per event however often Stripe redelivers it. What they take
// away is lib/revocation-policy.ts's decision; by default, a fully refunded
// purchase's credits are taken back, a partial refund or a refunded
// subscription invoice only recorded, and a disputed charge withholds what it
// paid for until the dispute is won. The charge is looked up afresh on every
// event, so events arriving late or out of order converge on Stripe's state.
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
  ONE_TIME_UNIT_AMOUNT,
  asNewUser,
  assertLogged,
  deliver,
  deliverOk,
  oneTimePurchaseCompleted,
  planOf,
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

async function creditsOf(userId) {
  const { rows } = await db.query("select credits from users where id = $1", [userId]);
  return rows[0]?.credits;
}

/** The audit log's entries for event `eventId`. */
async function auditedFor(eventId) {
  const { rows } = await db.query(
    "select action, resource_type, resource_id from audit_logs where metadata->>'eventId' = $1",
    [eventId]
  );
  return rows;
}

/** `user` buys `quantity` credits, paid with a charge Stripe now has (see charge()). */
async function purchase(user, { quantity = 3 } = {}) {
  const event = oneTimePurchaseCompleted(stripe, user, { quantity });
  await deliverOk(event);
  const { rows } = await db.query("select id from purchases where stripe_checkout_session_id = $1", [
    event.data.object.id,
  ]);
  return {
    purchaseId: rows[0].id,
    charge: charge(event.data.object.payment_intent, ONE_TIME_UNIT_AMOUNT * quantity),
  };
}

/** `user` subscribes to pro, its first invoice paid with a charge Stripe now has. */
async function subscribe(user) {
  const event = subscriptionCompleted(stripe, user);
  await deliverOk(event);
  const { subscription } = event.data.object;
  const { rows } = await db.query("select id from subscriptions where stripe_subscription_id = $1", [subscription]);
  const paymentIntent = `pi_test_${crypto.randomUUID()}`;
  const invoice = `in_test_${crypto.randomUUID()}`;
  stripe.add(
    {
      id: invoice,
      object: "invoice",
      parent: { type: "subscription_details", subscription_details: { subscription } },
    },
    {
      id: `inpay_test_${crypto.randomUUID()}`,
      object: "invoice_payment",
      invoice,
      payment: { type: "payment_intent", payment_intent: paymentIntent },
    }
  );
  return { subscriptionRowId: rows[0].id, subscription, charge: charge(paymentIntent, 2900) };
}

/**
 * A charge of `amount` for `paymentIntent`, as Stripe has it. Returns
 * { id, refund(amount), dispute(status) }, which change Stripe's copy, and
 * events for each.
 */
function charge(paymentIntent, amount) {
  const id = `ch_test_${crypto.randomUUID()}`;
  const disputeId = `dp_test_${crypto.randomUUID()}`;
  const stripeCharge = { id, object: "charge", payment_intent: paymentIntent, amount, amount_refunded: 0, refunded: false, disputed: false };
  stripe.add(stripeCharge);
  return {
    id,
    /** Refund `refunded` of it in total; the charge.refunded event. */
    refund(refunded = amount) {
      Object.assign(stripeCharge, { amount_refunded: refunded, refunded: refunded >= amount });
      stripe.add({ ...stripeCharge });
      return withId({ type: "charge.refunded", data: { object: { ...stripeCharge } } });
    },
    /** Its dispute is now in `status`; the event `type` reporting it. */
    dispute(type, status) {
      const dispute = { id: disputeId, object: "dispute", charge: id, payment_intent: paymentIntent, amount, status };
      stripeCharge.disputed = true;
      stripe.add({ ...stripeCharge }, dispute);
      return withId({ type, data: { object: dispute } });
    },
  };
}

test("a fully refunded purchase's credits are taken back, once, and the refund is recorded against it once", async () => {
  await asNewUser(db, async (user) => {
    const { purchaseId, charge } = await purchase(user, { quantity: 3 });
    assert.equal(await creditsOf(user.id), 3);

    const refunded = charge.refund();
    await deliverOk(refunded);
    assert.equal(await creditsOf(user.id), 0, "a full refund takes the purchase's credits back");
    await deliverOk(refunded);
    assert.equal(await creditsOf(user.id), 0);
    assert.deepEqual(await auditedFor(refunded.id), [
      { action: "billing.charge_refunded", resource_type: "purchase", resource_id: purchaseId },
    ]);
  });
});

test("a refund takes back no more credits than the user has left", async () => {
  await asNewUser(db, async (user) => {
    const { charge } = await purchase(user, { quantity: 3 });
    await db.query("update users set credits = 1 where id = $1", [user.id]);

    await deliverOk(charge.refund());
    assert.equal(await creditsOf(user.id), 0, "the balance never goes below zero");
  });
});

test("a partially refunded purchase is only recorded", async () => {
  await asNewUser(db, async (user) => {
    const { purchaseId, charge } = await purchase(user, { quantity: 3 });

    const refunded = charge.refund(ONE_TIME_UNIT_AMOUNT);
    await deliverOk(refunded);
    assert.equal(await creditsOf(user.id), 3, "a partial refund takes nothing back");
    assert.deepEqual(await auditedFor(refunded.id), [
      { action: "billing.charge_refunded", resource_type: "purchase", resource_id: purchaseId },
    ]);
  });
});

test("a disputed purchase's credits are withheld while the dispute is open, and given back when it is won", async () => {
  await asNewUser(db, async (user) => {
    const { purchaseId, charge } = await purchase(user, { quantity: 3 });

    const created = charge.dispute("charge.dispute.created", "needs_response");
    await deliverOk(created);
    await deliverOk(created);
    assert.equal(await creditsOf(user.id), 0, "an open dispute takes the credits back");
    assert.deepEqual(await auditedFor(created.id), [
      { action: "billing.dispute_created", resource_type: "purchase", resource_id: purchaseId },
    ]);

    const closed = charge.dispute("charge.dispute.closed", "won");
    await deliverOk(closed);
    await deliverOk(closed);
    assert.equal(await creditsOf(user.id), 3, "a won dispute gives them back, once");
    assert.deepEqual(await auditedFor(closed.id), [
      { action: "billing.dispute_closed", resource_type: "purchase", resource_id: purchaseId },
    ]);
  });
});

test("a lost dispute keeps the purchase's credits withheld", async () => {
  await asNewUser(db, async (user) => {
    const { charge } = await purchase(user, { quantity: 3 });

    await deliverOk(charge.dispute("charge.dispute.created", "needs_response"));
    await deliverOk(charge.dispute("charge.dispute.closed", "lost"));
    assert.equal(await creditsOf(user.id), 0);
  });
});

test("a disputed subscription grants nothing while the dispute is open, even after the subscription syncs, and its plan comes back when it is won", async () => {
  await asNewUser(db, async (user) => {
    const { subscriptionRowId, subscription, charge } = await subscribe(user);
    assert.equal(await planOf(db, user.id), "pro");

    const created = charge.dispute("charge.dispute.created", "needs_response");
    await deliverOk(created);
    assert.equal(await planOf(db, user.id), "free", "an open dispute suspends the plan");
    assert.deepEqual(await auditedFor(created.id), [
      { action: "billing.dispute_created", resource_type: "subscription", resource_id: subscriptionRowId },
    ]);

    // Stripe still has the subscription active: a sync mustn't undo the suspension.
    await deliverOk({ type: "customer.subscription.updated", data: { object: { id: subscription, object: "subscription" } } });
    assert.equal(await planOf(db, user.id), "free");

    await deliverOk(charge.dispute("charge.dispute.closed", "won"));
    assert.equal(await planOf(db, user.id), "pro", "a won dispute restores the plan");
  });
});

test("a lost dispute keeps the subscription suspended", async () => {
  await asNewUser(db, async (user) => {
    const { charge } = await subscribe(user);

    await deliverOk(charge.dispute("charge.dispute.created", "needs_response"));
    await deliverOk(charge.dispute("charge.dispute.closed", "lost"));
    assert.equal(await planOf(db, user.id), "free");
  });
});

test("a refunded subscription invoice is only recorded", async () => {
  await asNewUser(db, async (user) => {
    const { subscriptionRowId, charge } = await subscribe(user);

    const refunded = charge.refund();
    await deliverOk(refunded);
    assert.equal(await planOf(db, user.id), "pro", "cancelling the subscription is what ends the plan");
    assert.deepEqual(await auditedFor(refunded.id), [
      { action: "billing.charge_refunded", resource_type: "subscription", resource_id: subscriptionRowId },
    ]);
  });
});

test("a dispute's created event arriving after it was won withholds nothing", async () => {
  await asNewUser(db, async (user) => {
    const { charge } = await purchase(user, { quantity: 3 });

    const created = charge.dispute("charge.dispute.created", "needs_response");
    const closed = charge.dispute("charge.dispute.closed", "won");
    await deliverOk(closed);
    await deliverOk(created);
    assert.equal(await creditsOf(user.id), 3, "Stripe has the dispute won, whatever order its events arrive in");
  });
});

test("a refund arriving before its purchase is recorded is retried, and takes the credits back once it is", async () => {
  await asNewUser(db, async (user) => {
    const completed = oneTimePurchaseCompleted(stripe, user, { quantity: 3 });
    const { payment_intent } = completed.data.object;
    const refunded = charge(payment_intent, ONE_TIME_UNIT_AMOUNT * 3).refund();

    const res = await deliver(refunded);
    assert.ok(res.status >= 500, `the refund should be answered 5xx so Stripe retries it, got ${res.status}`);
    assertLogged(refunded.id);

    await deliverOk(completed);
    await deliverOk(refunded);
    assert.equal(await creditsOf(user.id), 0, "the redelivered refund takes back what the purchase granted");
  });
});

test("a refund of a charge the app recorded nothing for is acknowledged and logged", async () => {
  const refunded = charge(`pi_test_${crypto.randomUUID()}`, 1000).refund();
  await deliverOk(refunded);
  assertLogged(refunded.data.object.id);
});
