// Subscription lifecycle webhook integration tests (issue #27) — run against
// a REALLY RUNNING instance of a generated project (scripts/check_billing.sh
// boots one, with include_stripe=yes), not against mocks or the route
// handler imported in-process. That is the point of this file: before this
// fix, customer.subscription.updated wrote the new plan to the
// `subscriptions` row but never to `users.plan` — the column the rest of the
// app (the settings page, getPlanLimits) actually reads — so a type checker
// or an in-process unit test of the handler's return value would not have
// caught it. Only asserting on the database state after a real HTTP POST
// does.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Stripe from "stripe";
import {
  connectDb,
  insertTestUser,
  deleteTestUser,
} from "../../auth/support.mjs";
import { config, postWebhookEvent } from "./support.mjs";

const stripe = new Stripe("sk_test_dummy_key_for_offline_signature_tests", {
  typescript: true,
});

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
// webhook event claims. Rather than fight that collision by patching
// config.ts for determinism this test doesn't need, these tests only prove
// the one thing that matters: a seeded user/subscription NOT already on
// "pro" ends up on "pro" in both tables after the event — which is exactly
// what broke before the fix (only the `subscriptions` row moved).
const RESOLVED_PRICE_ID = "price_REPLACE_WITH_LIVE_PRICE_ID";

async function insertTestSubscription(db, userId, { plan, status = "active" }) {
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

async function getUserPlan(db, userId) {
  const result = await db.query("select plan from users where id = $1", [userId]);
  return result.rows[0]?.plan;
}

async function getSubscription(db, stripeSubscriptionId) {
  const result = await db.query(
    "select plan, status from subscriptions where stripe_subscription_id = $1",
    [stripeSubscriptionId]
  );
  return result.rows[0];
}

function subscriptionUpdatedPayload(stripeSubscriptionId, { priceId, status = "active" }) {
  return JSON.stringify({
    id: `evt_test_${crypto.randomUUID()}`,
    object: "event",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: stripeSubscriptionId,
        object: "subscription",
        status,
        items: {
          object: "list",
          data: [
            {
              id: "si_test_1",
              price: { id: priceId },
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            },
          ],
        },
      },
    },
  });
}

function subscriptionDeletedPayload(stripeSubscriptionId) {
  return JSON.stringify({
    id: `evt_test_${crypto.randomUUID()}`,
    object: "event",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: stripeSubscriptionId,
        object: "subscription",
      },
    },
  });
}

test("customer.subscription.updated moves both the subscription row and users.plan", async () => {
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      // Seeded on "enterprise", not "pro": the event below always resolves
      // to "pro" (see RESOLVED_PRICE_ID's comment), so starting anywhere
      // else proves the plan actually moved rather than having already
      // matched.
      await db.query("update users set plan = 'enterprise' where id = $1", [user.id]);
      const stripeSubscriptionId = await insertTestSubscription(db, user.id, {
        plan: "enterprise",
      });

      const payload = subscriptionUpdatedPayload(stripeSubscriptionId, {
        priceId: RESOLVED_PRICE_ID,
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: config.webhookSecret,
      });

      const res = await postWebhookEvent(payload, signature);
      assert.equal(res.status, 200, `webhook should return 200, got ${res.status}`);

      const subRecord = await getSubscription(db, stripeSubscriptionId);
      assert.equal(subRecord?.plan, "pro", "the subscriptions row should move to the new plan");

      const userPlan = await getUserPlan(db, user.id);
      assert.equal(
        userPlan,
        "pro",
        "users.plan should move with the subscription — this is the bug issue #27 fixes: " +
          "it previously stayed stale on the user's old plan"
      );
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
});

test("customer.subscription.deleted reverts the user to the free plan", async () => {
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      await db.query("update users set plan = 'pro' where id = $1", [user.id]);
      const stripeSubscriptionId = await insertTestSubscription(db, user.id, {
        plan: "pro",
      });

      const payload = subscriptionDeletedPayload(stripeSubscriptionId);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: config.webhookSecret,
      });

      const res = await postWebhookEvent(payload, signature);
      assert.equal(res.status, 200, `webhook should return 200, got ${res.status}`);

      const subRecord = await getSubscription(db, stripeSubscriptionId);
      assert.equal(subRecord?.status, "canceled");

      const userPlan = await getUserPlan(db, user.id);
      assert.equal(userPlan, "free");
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
});
