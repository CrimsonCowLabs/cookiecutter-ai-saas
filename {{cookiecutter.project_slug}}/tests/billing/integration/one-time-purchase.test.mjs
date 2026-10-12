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
// The webhook fetches the checkout session's line items from Stripe for the
// quantity bought, so the session is added to a stand-in Stripe API
// (../../compliance/fake-stripe.mjs) first. What happens when Stripe can't
// be reached is ./handler-failure.test.mjs's.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL, FAKE_STRIPE_PORT.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import { ONE_TIME_UNIT_AMOUNT, asNewUser, deliverOk, oneTimePurchaseCompleted, withId } from "./support.mjs";

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

async function purchaseRows(checkoutSessionId) {
  const result = await db.query(
    "select quantity, amount_total, currency, user_id from purchases where stripe_checkout_session_id = $1",
    [checkoutSessionId]
  );
  return result.rows;
}

async function getCredits(userId) {
  const result = await db.query("select credits from users where id = $1", [userId]);
  return result.rows[0]?.credits;
}

test("a one-time purchase is recorded and grants credits, exactly once even if redelivered", async () => {
  await asNewUser(db, async (user) => {
    assert.equal(await getCredits(user.id), 0, "a fresh test user should start with no credits");

    // Given an id, so that delivering it again is Stripe redelivering the
    // identical event (a retry, or a redelivery after a 2xx).
    const event = withId(oneTimePurchaseCompleted(stripe, user, { quantity: 2 }));
    const checkoutSessionId = event.data.object.id;

    // First delivery: recorded and granted.
    await deliverOk(event);

    let rows = await purchaseRows(checkoutSessionId);
    assert.equal(rows.length, 1, "exactly one purchase row after the first delivery");
    assert.equal(rows[0].quantity, 2);
    assert.equal(rows[0].amount_total, 2 * ONE_TIME_UNIT_AMOUNT);
    assert.equal(rows[0].currency, "usd");
    assert.equal(rows[0].user_id, user.id);

    assert.equal(await getCredits(user.id), 2, "credits should be granted once");

    await deliverOk(event);

    rows = await purchaseRows(checkoutSessionId);
    assert.equal(rows.length, 1, "the redelivery must not create a second purchase row");
    assert.equal(await getCredits(user.id), 2, "the redelivery must not grant credits a second time");
  });
});
