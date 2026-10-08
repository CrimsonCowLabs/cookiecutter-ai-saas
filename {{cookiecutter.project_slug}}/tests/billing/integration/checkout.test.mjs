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
// BASE_URL, NEXTAUTH_SECRET, DATABASE_URL, STRIPE_WEBHOOK_SECRET,
// FAKE_STRIPE_PORT; optionally, SERVER_LOG — the app's log file, checked for
// what the webhook logs about a checkout as a second Stripe customer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import Stripe from "stripe";
import { connectDb, insertTestUser, deleteTestUser, mintSessionCookie } from "../../auth/support.mjs";
import { startFakeStripe } from "../../compliance/fake-stripe.mjs";
import { config, postWebhookEvent } from "./support.mjs";

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

// Only used to sign events locally; never talks to Stripe.
const signer = new Stripe("sk_test_dummy_key_for_offline_signature_tests");

// The Price every paid plan resolves to under `next start`, matched as "pro"
// (see ./subscription-lifecycle.test.mjs).
const RESOLVED_PRICE_ID = "price_REPLACE_WITH_LIVE_PRICE_ID";

/** POST `event` to the webhook, signed the way Stripe signs it. */
function deliver(event) {
  const payload = JSON.stringify({ id: `evt_test_${crypto.randomUUID()}`, object: "event", ...event });
  return postWebhookEvent(payload, signer.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret }));
}

/**
 * The checkout.session.completed event for `user` subscribing as a Stripe
 * customer of the checkout's own, with the session, customer and
 * subscription it names made retrievable from the fake, since the webhook
 * looks each of them up.
 */
function subscriptionCompleted(user) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const session = {
    id: `cs_test_${id}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: user.id,
    customer: `cus_test_${id}`,
    subscription: `sub_test_${id}`,
    customer_details: { email: user.email },
  };
  stripe.add(
    { ...session, line_items: { object: "list", data: [{ quantity: 1, price: { id: RESOLVED_PRICE_ID } }] } },
    { id: session.customer, object: "customer", email: user.email },
    {
      id: session.subscription,
      object: "subscription",
      status: "active",
      items: {
        object: "list",
        data: [{ price: { id: RESOLVED_PRICE_ID }, current_period_start: now, current_period_end: now + 30 * 86_400 }],
      },
    }
  );
  return { type: "checkout.session.completed", data: { object: session } };
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

    // Each is either a checkout or, turned away while another was under way,
    // nowhere (the browser follows whichever redirect it gets).
    const destinations = await Promise.all(Array.from({ length: 5 }, () => startCheckout(cookie, field, PRO)));
    for (const d of destinations) if (d !== null) assert.match(d, checkoutUrl);
    assert.ok(destinations.some((d) => d !== null), "at least one request should reach a checkout");

    const customers = customersFor(user);
    assert.equal(customers.length, 1, `exactly one Stripe customer should be created, got ${customers.length}`);
    assert.equal(await storedCustomer(user), customers[0].id);

    const open = stripe.checkouts.filter((s) => s.params.customer === customers[0].id && s.status === "open");
    assert.equal(open.length, 1, `only the latest subscription checkout should still be payable, got ${open.length} open`);
  });
});

test("a checkout requested while another for the same user is under way is turned away at once, not queued", async () => {
  await asNewUser(async (user, cookie) => {
    const field = await upgradeActionField(cookie);
    const hold = stripe.holdNextCheckout();
    const first = startCheckout(cookie, field, PRO);
    await hold.reached;

    try {
      // Waiting its turn would hold a database connection for as long as the
      // first takes; it should give up straight away instead.
      const second = await Promise.race([
        startCheckout(cookie, field, PRO),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3_000)),
      ]);
      assert.equal(second, null, "the second request should be sent nowhere while the first is under way");
    } finally {
      hold.release();
    }

    assert.match((await first) ?? "", checkoutUrl, "the first request should still reach its checkout");
    assert.equal(customersFor(user).length, 1);
  });
});

test("a paid checkout as another Stripe customer keeps the user's own customer, grants the plan and is logged", async () => {
  await asNewUser(async (user) => {
    const ownCustomer = `cus_own_${crypto.randomUUID()}`;
    await db.query("update users set stripe_customer_id = $2 where id = $1", [user.id, ownCustomer]);

    // As a Stripe Payment Link would: a checkout the app didn't open, so
    // Stripe made it a customer of its own.
    const event = subscriptionCompleted(user);
    const res = await deliver(event);
    assert.equal(res.status, 200, `the webhook should accept the event, got ${res.status}`);

    const session = event.data.object;
    assert.equal(await storedCustomer(user), ownCustomer, "the user's own Stripe customer should be kept");
    const { rows } = await db.query("select plan from users where id = $1", [user.id]);
    assert.equal(rows[0].plan, PRO, "what they paid for should still be granted");
    const recorded = await db.query("select 1 from subscriptions where stripe_subscription_id = $1", [session.subscription]);
    assert.equal(recorded.rows.length, 1, "the subscription should be recorded");

    if (process.env.SERVER_LOG) {
      const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
      const line = log.split("\n").find((l) => l.includes(session.customer));
      assert.ok(line, `the server log should name the second customer, ${session.customer}`);
      assert.ok(line.includes(ownCustomer) && line.includes(user.id), "and the user and their own customer beside it");
    }
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
