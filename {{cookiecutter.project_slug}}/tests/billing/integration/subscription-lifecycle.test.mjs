// Subscription lifecycle webhook integration tests (issues #27 and #71) —
// run against a REALLY RUNNING instance of a generated project
// (scripts/check_billing.sh boots one, with include_stripe=yes), not against
// mocks or the route handler imported in-process, its Stripe client pointed
// at a stand-in API (../../compliance/fake-stripe.mjs). Only asserting on the
// database state after a real HTTP POST shows what the app grants: before
// #27, customer.subscription.updated wrote the new plan to the
// `subscriptions` row but never to `users.plan`, the column the rest of the
// app (the settings page, getPlanLimits) actually reads.
//
// Stripe redelivers events, sometimes hours late and in any order, so the
// webhook never trusts an event's payload: it fetches the subscription from
// Stripe and records what Stripe says now (#71). These tests change the
// subscription in the fake Stripe, as Stripe itself would, and then deliver
// events — fresh, repeated, concurrent and stale — to check that what the
// app records always converges on it.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL, FAKE_STRIPE_PORT.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectDb, insertTestUser, deleteTestUser } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import { RESOLVED_PRICE_ID, deliver, stripeSubscription, subscriptionCompleted } from "./support.mjs";

// config.ts's plan priceIds are literal, un-templated placeholders — not
// cookiecutter variables — and `next start` (which check_billing.sh uses)
// always forces NODE_ENV=production regardless of .env.local, so BOTH the
// "pro" and "enterprise" plans resolve to this exact same string:
//
//   priceId: process.env.NODE_ENV === "production"
//     ? "price_REPLACE_WITH_LIVE_PRICE_ID"
//     : "price_REPLACE_WITH_TEST_PRICE_ID"
//
// config.stripe.plans.find((p) => p.priceId === priceId) therefore always
// matches "pro" (the first array entry with this id), whichever tier a
// webhook event claims (RESOLVED_PRICE_ID in support.mjs). Rather than fight
// that collision by patching config.ts for determinism these tests don't
// need, a plan change is proven by seeding a user NOT on "pro" and seeing
// them end up on it.

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

/** Run `fn(user)` as a freshly inserted user, deleted again afterwards. */
async function asNewUser(fn) {
  const user = await insertTestUser(db);
  try {
    return await fn(user);
  } finally {
    await deleteTestUser(db, user.id);
  }
}

async function insertTestSubscription(userId, { plan, status = "active" }) {
  const stripeSubscriptionId = `sub_test_${crypto.randomUUID()}`;
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db.query(
    `insert into subscriptions
       (user_id, stripe_subscription_id, stripe_price_id, plan, status, current_period_start, current_period_end)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, stripeSubscriptionId, RESOLVED_PRICE_ID, plan, status, now, periodEnd]
  );
  return stripeSubscriptionId;
}

async function getUserPlan(userId) {
  const result = await db.query("select plan from users where id = $1", [userId]);
  return result.rows[0]?.plan;
}

async function getSubscriptions(stripeSubscriptionId) {
  const result = await db.query(
    "select plan, status from subscriptions where stripe_subscription_id = $1",
    [stripeSubscriptionId]
  );
  return result.rows;
}

/** Make Stripe's copy of subscription `id` (of `customer`) be in `status`. */
function setStripeStatus(id, customer, status) {
  stripe.add(stripeSubscription(id, { customer, status }));
}

/**
 * A customer.subscription.updated or .deleted event for subscription `id`,
 * its payload claiming `status` — which the webhook should ignore in favour
 * of what Stripe says now.
 */
function subscriptionEvent(type, id, { customer, status = "active" } = {}) {
  return { type, data: { object: stripeSubscription(id, { customer, status }) } };
}

async function deliverOk(event) {
  const res = await deliver(event);
  assert.equal(res.status, 200, `the webhook should accept ${event.type}, got ${res.status}`);
}

test("customer.subscription.updated moves both the subscription row and users.plan", async () => {
  await asNewUser(async (user) => {
    // Seeded on "enterprise", not "pro": Stripe's subscription always
    // resolves to "pro" (see the comment at the top), so starting anywhere
    // else proves the plan actually moved rather than having already matched.
    await db.query("update users set plan = 'enterprise' where id = $1", [user.id]);
    const id = await insertTestSubscription(user.id, { plan: "enterprise" });
    setStripeStatus(id, "cus_test_unused", "active");

    await deliverOk(subscriptionEvent("customer.subscription.updated", id));

    const [row] = await getSubscriptions(id);
    assert.equal(row?.plan, "pro", "the subscriptions row should move to the new plan");
    assert.equal(
      await getUserPlan(user.id),
      "pro",
      "users.plan should move with the subscription — this is the bug issue #27 fixes: " +
        "it previously stayed stale on the user's old plan"
    );
  });
});

test("customer.subscription.deleted reverts the user to the free plan", async () => {
  await asNewUser(async (user) => {
    await db.query("update users set plan = 'pro' where id = $1", [user.id]);
    const id = await insertTestSubscription(user.id, { plan: "pro" });
    setStripeStatus(id, "cus_test_unused", "canceled");

    await deliverOk(subscriptionEvent("customer.subscription.deleted", id, { status: "canceled" }));

    const [row] = await getSubscriptions(id);
    assert.equal(row?.status, "canceled");
    assert.equal(await getUserPlan(user.id), "free");
  });
});

test("the same checkout.session.completed delivered twice leaves one subscription row and the plan", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    await deliverOk(event);
    await deliverOk(event);

    const rows = await getSubscriptions(event.data.object.subscription);
    assert.equal(rows.length, 1, `exactly one subscription row should be recorded, got ${rows.length}`);
    assert.deepEqual(rows[0], { plan: "pro", status: "active" });
    assert.equal(await getUserPlan(user.id), "pro");
  });
});

test("two copies of checkout.session.completed delivered at once leave one subscription row and the plan", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const responses = await Promise.all([deliver(event), deliver(event)]);
    for (const res of responses) assert.equal(res.status, 200);

    const rows = await getSubscriptions(event.data.object.subscription);
    assert.equal(rows.length, 1, `exactly one subscription row should be recorded, got ${rows.length}`);
    assert.equal(rows[0].status, "active");
    assert.equal(await getUserPlan(user.id), "pro");
  });
});

test("an old checkout.session.completed replayed after the subscription was cancelled leaves the user on free", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const { subscription, customer } = event.data.object;
    await deliverOk(event);

    setStripeStatus(subscription, customer, "canceled");
    await deliverOk(subscriptionEvent("customer.subscription.deleted", subscription, { customer, status: "canceled" }));
    assert.equal(await getUserPlan(user.id), "free");

    await deliverOk(event);
    assert.equal(await getUserPlan(user.id), "free", "a stale checkout event should not grant the plan again");
    assert.deepEqual(
      (await getSubscriptions(subscription)).map((r) => r.status),
      ["canceled"],
      "the subscription should stay recorded as canceled"
    );
  });
});

test("a stale customer.subscription.updated arriving after the cancellation leaves the user on free", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const { subscription, customer } = event.data.object;
    await deliverOk(event);

    setStripeStatus(subscription, customer, "canceled");
    await deliverOk(subscriptionEvent("customer.subscription.deleted", subscription, { customer, status: "canceled" }));

    // Sent by Stripe before the cancellation, delivered after it.
    await deliverOk(subscriptionEvent("customer.subscription.updated", subscription, { customer, status: "active" }));
    assert.equal(await getUserPlan(user.id), "free", "a stale update should not grant the plan again");
    assert.deepEqual((await getSubscriptions(subscription)).map((r) => r.status), ["canceled"]);
  });
});

test("customer.subscription.deleted arriving before checkout.session.completed still ends on free", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const { subscription, customer } = event.data.object;
    setStripeStatus(subscription, customer, "canceled");

    await deliverOk(subscriptionEvent("customer.subscription.deleted", subscription, { customer, status: "canceled" }));
    await deliverOk(event);

    assert.equal(await getUserPlan(user.id), "free");
    assert.deepEqual((await getSubscriptions(subscription)).map((r) => r.status), ["canceled"]);
  });
});

test("a subscription moving to past_due keeps the plan; moving on to unpaid reverts to free", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const { subscription, customer } = event.data.object;
    await deliverOk(event);

    setStripeStatus(subscription, customer, "past_due");
    await deliverOk(subscriptionEvent("customer.subscription.updated", subscription, { customer }));
    assert.deepEqual((await getSubscriptions(subscription)).map((r) => r.status), ["past_due"]);
    assert.equal(await getUserPlan(user.id), "pro", "past_due is grace while Stripe retries the card");

    setStripeStatus(subscription, customer, "unpaid");
    await deliverOk(subscriptionEvent("customer.subscription.updated", subscription, { customer }));
    assert.deepEqual((await getSubscriptions(subscription)).map((r) => r.status), ["unpaid"]);
    assert.equal(await getUserPlan(user.id), "free", "unpaid ends the grace");
  });
});

test("a trialing subscription grants its tier", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(stripe, user);
    const { subscription, customer } = event.data.object;
    setStripeStatus(subscription, customer, "trialing");

    await deliverOk(event);

    assert.deepEqual((await getSubscriptions(subscription)).map((r) => r.status), ["trialing"]);
    assert.equal(await getUserPlan(user.id), "pro");
  });
});

// Every status Stripe can report (Stripe.Subscription.Status), and the plan
// each one leaves the user on.
const ENTITLEMENT = {
  active: "pro",
  trialing: "pro",
  past_due: "pro",
  unpaid: "free",
  canceled: "free",
  incomplete: "free",
  incomplete_expired: "free",
  paused: "free",
};

for (const [status, plan] of Object.entries(ENTITLEMENT)) {
  test(`a subscription Stripe reports as ${status} is recorded as ${status}, and leaves the user on ${plan}`, async () => {
    await asNewUser(async (user) => {
      // Arriving from "enterprise", so "pro" is visibly granted, not kept.
      await db.query("update users set plan = 'enterprise' where id = $1", [user.id]);
      const id = await insertTestSubscription(user.id, { plan: "enterprise" });
      setStripeStatus(id, "cus_test_unused", status);

      await deliverOk(subscriptionEvent("customer.subscription.updated", id));

      assert.deepEqual((await getSubscriptions(id)).map((r) => r.status), [status], "stored as itself, never relabelled");
      assert.equal(await getUserPlan(user.id), plan);
    });
  });
}

test("a stale event for a user's old, cancelled subscription leaves their current one's plan alone", async () => {
  await asNewUser(async (user) => {
    const old = subscriptionCompleted(stripe, user);
    const { subscription: oldId, customer } = old.data.object;
    setStripeStatus(oldId, customer, "canceled");
    await deliverOk(old);

    const current = subscriptionCompleted(stripe, user);
    await deliverOk(current);
    assert.equal(await getUserPlan(user.id), "pro");

    await deliverOk(subscriptionEvent("customer.subscription.deleted", oldId, { customer, status: "canceled" }));
    await deliverOk(old);
    assert.equal(await getUserPlan(user.id), "pro", "the current subscription still entitles the user");
  });
});
