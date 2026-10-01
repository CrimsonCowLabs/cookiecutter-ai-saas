// One-time purchase webhook integration tests (issue #27) — run against a
// REALLY RUNNING instance of a generated project (scripts/check_billing.sh
// boots one, with include_stripe=yes), not against mocks or the route
// handler imported in-process. Before this fix, the one-time-purchase branch
// of checkout.session.completed logged a message and did nothing: a real
// payment left no record and granted nothing. This proves two things only a
// real HTTP round trip against a real database can: that a purchase is both
// recorded and granted, and that it stays exactly-once granted when Stripe
// redelivers the same event — which it does, on anything but a 2xx response,
// and sometimes even after one.
//
// This branch calls findCheckoutSession() (lib/stripe.ts), which hits the
// real Stripe API — but that function catches its own errors and returns
// null on any failure, so it tolerates the dummy STRIPE_SECRET_KEY
// scripts/check_billing.sh sets without needing real credentials. With a
// null session, the handler falls back to quantity 1 and a null price id —
// which is exactly what these tests assert on, deterministically.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Stripe from "stripe";
import { connectDb, insertTestUser, deleteTestUser } from "../../auth/support.mjs";
import { config, postWebhookEvent } from "./support.mjs";

const stripe = new Stripe("sk_test_dummy_key_for_offline_signature_tests", {
  typescript: true,
});

function oneTimePurchasePayload(checkoutSessionId, userId) {
  return JSON.stringify({
    id: `evt_test_${crypto.randomUUID()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: checkoutSessionId,
        object: "checkout.session",
        client_reference_id: userId,
        metadata: { type: "one_time_purchase" },
        amount_total: 1999,
        currency: "usd",
      },
    },
  });
}

async function purchaseRows(db, checkoutSessionId) {
  const result = await db.query(
    "select quantity, amount_total, currency, user_id from purchases where stripe_checkout_session_id = $1",
    [checkoutSessionId]
  );
  return result.rows;
}

async function getCredits(db, userId) {
  const result = await db.query("select credits from users where id = $1", [userId]);
  return result.rows[0]?.credits;
}

test("a one-time purchase is recorded and grants credits, exactly once even if redelivered", async () => {
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      const startingCredits = await getCredits(db, user.id);
      assert.equal(startingCredits, 0, "a fresh test user should start with no credits");

      const checkoutSessionId = `cs_test_${crypto.randomUUID()}`;
      const payload = oneTimePurchasePayload(checkoutSessionId, user.id);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: config.webhookSecret,
      });

      // First delivery: recorded and granted.
      const firstRes = await postWebhookEvent(payload, signature);
      assert.equal(firstRes.status, 200, `webhook should return 200, got ${firstRes.status}`);

      let rows = await purchaseRows(db, checkoutSessionId);
      assert.equal(rows.length, 1, "exactly one purchase row after the first delivery");
      assert.equal(rows[0].quantity, 1);
      assert.equal(rows[0].amount_total, 1999);
      assert.equal(rows[0].currency, "usd");
      assert.equal(rows[0].user_id, user.id);

      assert.equal(await getCredits(db, user.id), 1, "credits should be granted once");

      // Stripe redelivers the identical event (retry, or a redelivery after
      // a 2xx) — the exact same signed payload, sent again.
      const secondRes = await postWebhookEvent(payload, signature);
      assert.equal(secondRes.status, 200, `redelivery should still return 200, got ${secondRes.status}`);

      rows = await purchaseRows(db, checkoutSessionId);
      assert.equal(rows.length, 1, "the redelivery must not create a second purchase row");

      assert.equal(
        await getCredits(db, user.id),
        1,
        "the redelivery must not grant credits a second time"
      );
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
});
