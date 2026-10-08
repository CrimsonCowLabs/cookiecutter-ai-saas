// Checkout integration tests (issue #72): one Stripe customer, and at most
// one live subscription, per user — run against a REALLY RUNNING instance of
// a generated project (scripts/check_billing.sh boots one, with
// include_stripe=yes), its Stripe client pointed at a stand-in API
// (../../compliance/fake-stripe.mjs) that records every customer, Checkout
// Session and portal session the app creates.
//
// Checkout is started the way a browser without JavaScript would start it:
// by POSTing the settings page's upgrade form, server-action id and all, as
// a signed-in user. The dashboard's pending-plan resume
// (components/dashboard/resume-pending-plan.tsx) submits that same action
// with that same `planId` field, so what holds here holds for it too.
//
// Env vars (see ../../auth/support.mjs and ./support.mjs for defaults):
// BASE_URL, NEXTAUTH_SECRET, DATABASE_URL, FAKE_STRIPE_PORT.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectDb, insertTestUser, deleteTestUser, mintSessionCookie } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import { config } from "./support.mjs";

// Tiers only: which Stripe Price each resolves to doesn't matter here (see
// ./subscription-lifecycle.test.mjs on why they collide under `next start`).
const PRO = "pro";
const ENTERPRISE = "enterprise";

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

/** Run `fn(user, cookie)` as a freshly inserted, signed-in user. */
async function asNewUser(fn) {
  const user = await insertTestUser(db);
  try {
    return await fn(user, await mintSessionCookie(user));
  } finally {
    await deleteTestUser(db, user.id);
  }
}

/**
 * The hidden field that names the upgrade form's server action, read off the
 * settings page as `cookie`'s user (on the free plan) sees it.
 */
async function upgradeActionField(cookie) {
  const res = await fetch(new URL("/dashboard/settings", config.baseUrl), { headers: { cookie } });
  assert.equal(res.status, 200, `/dashboard/settings should load for a signed-in user, got ${res.status}`);
  const html = await res.text();
  const field = html.match(/name="(\$ACTION_ID_[0-9a-f]+)"/)?.[1];
  assert.ok(field, "the settings page's upgrade form should carry its server action's id");
  return field;
}

/**
 * Submit the upgrade form for `planId` as `cookie`'s user, and return where
 * the app sends them (the redirect's Location), or null if it sends them
 * nowhere.
 */
async function startCheckout(cookie, field, planId) {
  const form = new FormData();
  form.set(field, "");
  form.set("planId", planId);
  const res = await fetch(new URL("/dashboard/settings", config.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: new URL(config.baseUrl).origin },
    body: form,
  });
  assert.ok(res.status < 500, `starting checkout should not fail, got ${res.status}`);
  return res.headers.get("location");
}

const checkoutUrl = /^http:\/\/localhost:\d+\/pay\/cs_/;
const portalUrl = /^http:\/\/localhost:\d+\/portal\/bps_/;

const customersFor = (user) => stripe.customers.filter((c) => c.params["metadata[userId]"] === user.id);

async function storedCustomer(user) {
  const { rows } = await db.query("select stripe_customer_id from users where id = $1", [user.id]);
  return rows[0]?.stripe_customer_id;
}

/** A subscription row for `user`, as the webhook records one. */
async function recordSubscription(user, { plan = PRO, status = "active" } = {}) {
  const now = new Date();
  await db.query(
    `insert into subscriptions
       (user_id, stripe_subscription_id, stripe_price_id, plan, status, current_period_start, current_period_end)
     values ($1, $2, 'price_test', $3, $4, $5, $6)`,
    [user.id, `sub_test_${crypto.randomUUID()}`, plan, status, now, new Date(now.getTime() + 30 * 864e5)]
  );
  await db.query("update users set plan = $2 where id = $1", [user.id, status === "canceled" ? "free" : plan]);
}

test("a user who abandons a checkout and starts another checks out as the same Stripe customer both times", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);

    assert.match(await startCheckout(cookie, field, PRO), checkoutUrl);
    assert.match(await startCheckout(cookie, field, PRO), checkoutUrl);

    const customers = customersFor(user);
    assert.equal(customers.length, 1, "exactly one Stripe customer should be created for the user");
    assert.equal(customers[0].params.email, user.email, "the customer should carry the user's email");
    assert.equal(await storedCustomer(user), customers[0].id, "the user should be stored against that customer");

    const sessions = stripe.checkouts.filter((s) => s.params.customer === customers[0].id);
    assert.equal(sessions.length, 2, "both checkouts should be for that customer");
    for (const s of sessions) {
      assert.equal(s.params.customer_email, undefined, "a checkout should name the customer, not just an email");
    }
  });
});

test("concurrent first checkouts for one user create one Stripe customer and leave one checkout open", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);

    const destinations = await Promise.all(Array.from({ length: 5 }, () => startCheckout(cookie, field, PRO)));
    for (const d of destinations) assert.match(d ?? "", checkoutUrl);

    const customers = customersFor(user);
    assert.equal(customers.length, 1, `exactly one Stripe customer should be created, got ${customers.length}`);
    assert.equal(await storedCustomer(user), customers[0].id);

    const open = stripe.checkouts.filter((s) => s.params.customer === customers[0].id && s.status === "open");
    assert.equal(open.length, 1, `only the latest subscription checkout should still be payable, got ${open.length} open`);
  });
});

test("a user with a live subscription who asks for a subscription checkout is sent to the billing portal", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);
    await recordSubscription(user, { plan: PRO, status: "past_due" });
    const before = stripe.checkouts.length;

    const destination = await startCheckout(cookie, field, ENTERPRISE);

    assert.match(destination ?? "", portalUrl, "the user should be sent to the billing portal to change plan");
    assert.equal(stripe.checkouts.length, before, "no Checkout Session should be created");
    const [customer] = customersFor(user);
    assert.ok(customer, "the portal needs the user's Stripe customer, so one should exist");
    assert.equal(stripe.portals.at(-1).params.customer, customer.id, "the portal should be the user's own");
  });
});

test("a subscription Stripe knows about but the webhook has not recorded yet also sends the user to the portal", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);
    assert.match(await startCheckout(cookie, field, PRO), checkoutUrl);
    const customer = await storedCustomer(user);
    // Paid, but checkout.session.completed has not arrived yet.
    stripe.add({ id: `sub_test_${crypto.randomUUID()}`, object: "subscription", customer, status: "active" });
    const before = stripe.checkouts.length;

    assert.match((await startCheckout(cookie, field, PRO)) ?? "", portalUrl);
    assert.equal(stripe.checkouts.length, before, "no second Checkout Session should be created");
  });
});

test("a user whose subscription was cancelled can check out again, as the same customer", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);
    assert.match(await startCheckout(cookie, field, PRO), checkoutUrl);
    const customer = await storedCustomer(user);
    await recordSubscription(user, { plan: PRO, status: "canceled" });
    stripe.add({ id: `sub_test_${crypto.randomUUID()}`, object: "subscription", customer, status: "canceled" });

    assert.match((await startCheckout(cookie, field, PRO)) ?? "", checkoutUrl);
    assert.equal(stripe.checkouts.at(-1).params.customer, customer);
    assert.equal(customersFor(user).length, 1);
  });
});
