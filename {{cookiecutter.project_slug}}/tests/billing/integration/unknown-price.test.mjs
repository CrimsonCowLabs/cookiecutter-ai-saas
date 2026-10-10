// Unknown price webhook integration tests (issue #74) — run against a REALLY
// RUNNING instance of a generated project (scripts/check_billing.sh boots
// one, with include_stripe=yes), its Stripe client pointed at a stand-in API
// (../../compliance/fake-stripe.mjs).
//
// A subscription on a Stripe Price that no plan in config.ts names (a price
// changed in Stripe, a legacy one, the other environment's) can't be mapped
// to a tier. That is never left silent: the webhook logs an error and writes
// an audit record naming the user, their Stripe customer, the price and the
// event, so the operator can find the customer and fix it. The event is
// still acknowledged, since redelivering it can't fix the config.
//
// Env vars (see support.mjs for defaults): BASE_URL, STRIPE_WEBHOOK_SECRET,
// DATABASE_URL, FAKE_STRIPE_PORT; optionally, SERVER_LOG — the app's log
// file, checked for the error the webhook logs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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

const unknownPrice = () => `price_unknown_${crypto.randomUUID()}`;

/** `event`, given an id of its own to find it by. */
const withId = (event) => ({ id: `evt_test_${crypto.randomUUID()}`, ...event });

async function unknownPriceAudits(eventId) {
  const { rows } = await db.query(
    "select user_id, metadata from audit_logs where action = 'billing.unknown_price' and metadata->>'eventId' = $1",
    [eventId]
  );
  return rows;
}

/** Assert the server log has an error line naming each of `names`. */
function assertLogged(...names) {
  if (!process.env.SERVER_LOG) return;
  const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
  const line = log.split("\n").find((l) => names.every((n) => l.includes(n)));
  assert.ok(line, `the server log should have a line naming ${names.join(", ")}`);
}

test("a paid checkout for an unknown price is acknowledged, grants nothing, and is logged and audited", async () => {
  await asNewUser(db, async (user) => {
    const price = unknownPrice();
    const event = withId(subscriptionCompleted(stripe, user, { priceId: price }));
    const { customer, subscription } = event.data.object;

    await deliverOk(event);

    assert.equal(await planOf(db, user.id), "free", "an unknown price grants no plan");
    const audits = await unknownPriceAudits(event.id);
    assert.equal(audits.length, 1, `the unknown price should be audited, got ${audits.length}`);
    assert.equal(audits[0].user_id, user.id, "against the user who paid");
    assert.equal(audits[0].metadata.priceId, price);
    assert.equal(audits[0].metadata.customerId, customer);
    assert.equal(audits[0].metadata.subscriptionId, subscription);
    assert.equal(audits[0].metadata.eventType, "checkout.session.completed");
    assertLogged(price, event.id, user.id, customer);
  });
});

test("a subscription moved to an unknown price keeps its plan, and the update is logged and audited", async () => {
  await asNewUser(db, async (user) => {
    const completed = subscriptionCompleted(stripe, user);
    const { customer, subscription } = completed.data.object;
    await deliverOk(completed);
    assert.equal(await planOf(db, user.id), "pro");

    // Changed in Stripe (the dashboard, or a portal configured with prices
    // config.ts doesn't list) to a price the app has never heard of.
    const price = unknownPrice();
    const moved = stripeSubscription(subscription, { customer, priceId: price });
    stripe.add(moved);
    const updated = withId({ type: "customer.subscription.updated", data: { object: moved } });
    await deliverOk(updated);

    assert.equal(await planOf(db, user.id), "pro", "what they had paid for is kept until the operator decides");
    const audits = await unknownPriceAudits(updated.id);
    assert.equal(audits.length, 1, `the unknown price should be audited, got ${audits.length}`);
    assert.equal(audits[0].user_id, user.id);
    assert.equal(audits[0].metadata.priceId, price);
    assert.equal(audits[0].metadata.customerId, customer);
    assert.equal(audits[0].metadata.eventType, "customer.subscription.updated");
    assertLogged(price, updated.id, user.id, customer);
  });
});

test("a subscription on a configured price writes no unknown-price audit", async () => {
  await asNewUser(db, async (user) => {
    const event = withId(subscriptionCompleted(stripe, user));
    await deliverOk(event);
    assert.equal(await planOf(db, user.id), "pro");
    assert.equal((await unknownPriceAudits(event.id)).length, 0);
  });
});
