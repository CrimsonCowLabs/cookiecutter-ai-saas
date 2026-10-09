// A new subscriber is sent an acknowledgment that repeats the renewal terms
// and says how to cancel (California's Automatic Renewal Law) — run against a
// REALLY RUNNING app (scripts/check_compliance.sh boots one), by posting it
// signed Stripe webhook events the way Stripe would. The app's Stripe client
// is pointed at a stand-in API (./fake-stripe.mjs) that answers what the
// webhook looks up, and its Resend client at another (./fake-resend.mjs) that
// records every email sent. See docs/compliance.md, "Subscriptions and
// automatic renewal".
//
// The same harness also proves the webhook never creates an account: a paid
// checkout from someone without one is logged and left for the operator (see
// docs/compliance.md, "Children's privacy (COPPA)").
//
// Only ships in projects generated with Stripe.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus STRIPE_WEBHOOK_SECRET (the one the app
// verifies events with), FAKE_STRIPE_PORT (see ./fake-stripe.mjs),
// FAKE_RESEND_PORT (see ./fake-resend.mjs) and NO_RESEND_APP_PORT (below);
// optionally, SERVER_LOG — the app's log file, checked for what the webhook
// logs about a checkout it could not fulfil.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import Stripe from "stripe";
import { config, connectDb, insertTestUser, deleteTestUser } from "../auth/support.mjs";
import { configuredPlans, unescapeHtml } from "./support.mjs";
import { startFakeStripe } from "./fake-stripe.mjs";
import { startFakeResend } from "./fake-resend.mjs";

// The value scripts/check_compliance.sh boots the app with. A fixed,
// low-entropy placeholder, not a real credential.
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_0000000000000000000000000000000000000000";

// Where a second copy of the app runs, the same build with Resend not
// configured, for the test that nothing is sent then.
const NO_RESEND_APP_PORT = Number(process.env.NO_RESEND_APP_PORT || 3001);

// Only used to sign events locally; never talks to Stripe.
const signer = new Stripe("sk_test_dummy_key_for_offline_signature_tests");

// The first paid plan, with the Stripe Price id the running app knows it by.
const plan = configuredPlans().find((p) => p.price > 0 && p.priceId);
assert.ok(plan, "config.ts should list a paid plan with a priceId");

/** The renewal terms the landing page shows beside `plan`'s button. */
async function termsShownFor(plan) {
  const html = await (await fetch(new URL("/", config.baseUrl))).text();
  const shown = html.match(new RegExp(`id="renewal-terms-${plan.tier}"[^>]*>([^<]+)<`))?.[1];
  assert.ok(shown, `the landing page should show ${plan.name}'s renewal terms`);
  return unescapeHtml(shown);
}

let stripe;
let resend;
let db;
before(async () => {
  stripe = await startFakeStripe();
  resend = await startFakeResend();
  db = await connectDb();
});
after(async () => {
  await stripe?.close();
  await resend?.close();
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

/**
 * POST `event`, signed the way Stripe signs it, to the app at `baseUrl`, and
 * return the response status. Unless `{ expectOk: false }`, assert the
 * webhook accepted it (a 2xx; anything else and Stripe redelivers it).
 */
async function deliver(event, baseUrl = config.baseUrl, { expectOk = true } = {}) {
  const payload = JSON.stringify({ id: `evt_test_${crypto.randomUUID()}`, object: "event", ...event });
  const res = await fetch(new URL("/api/webhook/stripe", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
    },
    body: payload,
  });
  if (expectOk) assert.equal(res.status, 200, `the webhook should accept ${event.type}, got ${res.status}`);
  return res.status;
}

/**
 * The checkout.session.completed event for `user` subscribing to `plan`, with
 * the session, customer and subscription it names made retrievable from the
 * fake Stripe API, since the webhook looks each of them up. `user.id` is the
 * session's client_reference_id; leave it null for a checkout started without
 * one (a Stripe Payment Link, say).
 */
function subscriptionCompleted(user, plan) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const session = {
    id: `cs_test_${id}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: user.id ?? null,
    customer: `cus_test_${id}`,
    subscription: `sub_test_${id}`,
    customer_details: { email: user.email },
  };
  stripe.add(
    { ...session, line_items: { object: "list", data: [{ quantity: 1, price: { id: plan.priceId } }] } },
    { id: session.customer, object: "customer", email: user.email },
    {
      id: session.subscription,
      object: "subscription",
      status: "active",
      items: {
        object: "list",
        data: [{ price: { id: plan.priceId }, current_period_start: now, current_period_end: now + 365 * 24 * 60 * 60 }],
      },
    }
  );
  return { type: "checkout.session.completed", data: { object: session } };
}

const emailsTo = (user) => resend.emails.filter((e) => [e.to].flat().includes(user.email));

async function subscriptionRecorded(subscriptionId) {
  const { rows } = await db.query(`select 1 from subscriptions where stripe_subscription_id = $1`, [subscriptionId]);
  return rows.length > 0;
}

/** Whether the subscription's row records that its acknowledgment went out. */
async function acknowledged(subscriptionId) {
  const { rows } = await db.query(`select acknowledged_at from subscriptions where stripe_subscription_id = $1`, [
    subscriptionId,
  ]);
  return rows[0]?.acknowledged_at != null;
}

test("a completed subscription checkout sends exactly one acknowledgment, with the renewal terms and how to cancel", async () => {
  const terms = await termsShownFor(plan);
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(user, plan);
    await deliver(event);
    // Stripe redelivers events; a redelivery is not a second subscription.
    await deliver(event);

    const sent = emailsTo(user);
    assert.equal(sent.length, 1, `exactly one acknowledgment should be sent to the subscriber, got ${sent.length}`);
    const [email] = sent;
    const text = `${email.subject}\n${email.text}`;
    assert.ok(
      email.text.includes(terms),
      `the acknowledgment should repeat, word for word, the renewal terms shown beside the subscribe button:\n  "${terms}"\ngot:\n${email.text}`
    );
    assert.ok(text.includes(plan.name), `the acknowledgment should name the plan, ${plan.name}`);
    const settings = new URL("/dashboard/settings", config.baseUrl).href;
    assert.ok(email.text.includes(settings), `the acknowledgment should link to the settings, ${settings}`);
    for (const step of [/Manage billing/, /billing portal/i, /cancel/i]) {
      assert.match(email.text, step, `the acknowledgment's cancellation steps should mention ${step.source}`);
    }
  });
});

test("the acknowledgment is sent with an idempotency key for its subscription, and recorded as sent", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(user, plan);
    const subscriptionId = event.data.object.subscription;
    await deliver(event);
    const sent = emailsTo(user);
    assert.equal(sent.length, 1, `one acknowledgment should be sent, got ${sent.length}`);
    // Resend sends a key's email once, so two deliveries racing each other,
    // or a crash between sending and recording it, can't send it twice.
    assert.equal(sent[0].idempotencyKey, `subscription-acknowledgment/${subscriptionId}`);
    assert.ok(await acknowledged(subscriptionId), "the subscription should record that its acknowledgment was sent");
  });
});

test("a failed acknowledgment send fails the event, so Stripe's redelivery sends it", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(user, plan);
    const subscriptionId = event.data.object.subscription;

    resend.failNext();
    const status = await deliver(event, config.baseUrl, { expectOk: false });
    assert.ok(status >= 500, `the webhook should answer a failed send with a 5xx, so Stripe redelivers the event; got ${status}`);
    assert.ok(await subscriptionRecorded(subscriptionId), "the subscription should still be recorded");
    assert.equal(emailsTo(user).length, 0, "no acknowledgment should have been sent yet");
    assert.equal(await acknowledged(subscriptionId), false, "the subscription should not be recorded as acknowledged");

    // Stripe redelivers it, with Resend back up.
    await deliver(event);
    assert.equal(emailsTo(user).length, 1, "the redelivery should send the acknowledgment");
    assert.ok(await acknowledged(subscriptionId), "the subscription should now be recorded as acknowledged");

    await deliver(event);
    assert.equal(emailsTo(user).length, 1, "a further redelivery should send nothing more");
  });
});

test("two deliveries of the same event at once send one acknowledgment", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(user, plan);
    await Promise.all([deliver(event), deliver(event)]);
    assert.equal(emailsTo(user).length, 1, `exactly one acknowledgment should be sent, got ${emailsTo(user).length}`);
  });
});

test("a checkout event for a subscription cancelled before it arrived records it and sends nothing", async () => {
  await asNewUser(async (user) => {
    const event = subscriptionCompleted(user, plan);
    const { subscription, customer } = event.data.object;
    // Stripe redelivers events hours late; by then the subscription has ended.
    stripe.add({
      id: subscription,
      object: "subscription",
      customer,
      status: "canceled",
      items: { object: "list", data: [{ price: { id: plan.priceId } }] },
    });
    await deliver(event);
    assert.ok(await subscriptionRecorded(subscription), "the subscription should be recorded, as canceled");
    assert.equal(emailsTo(user).length, 0, "no acknowledgment should be sent for a subscription that has already ended");
  });
});

// Accounts are created only by Auth.js, behind the age gate (lib/auth.ts), so a
// paid checkout from someone with no account is logged for the operator to
// reconcile, never fulfilled by making them one.
for (const [what, buyer] of [
  ["no client_reference_id, and an email with no account", () => ({ id: null })],
  ["a client_reference_id whose account no longer exists", () => ({ id: crypto.randomUUID() })],
]) {
  test(`a subscription checkout with ${what} creates no account and records nothing`, async () => {
    const user = { ...buyer(), email: `compliance-no-account-${crypto.randomUUID()}@example.com` };
    const event = subscriptionCompleted(user, plan);
    const session = event.data.object;
    // Accepted, so Stripe stops redelivering an event that would change nothing.
    await deliver(event);

    const { rows } = await db.query(`select id from users where email = $1`, [user.email]);
    if (rows.length) await db.query(`delete from users where email = $1`, [user.email]);
    assert.equal(rows.length, 0, "the webhook should never create an account; only sign-up does, behind the age gate");
    assert.equal(await subscriptionRecorded(session.subscription), false, "no subscription should be recorded");
    assert.equal(emailsTo(user).length, 0, "no acknowledgment should be sent");
    if (process.env.SERVER_LOG) {
      const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
      assert.ok(log.includes(session.id), `the server log should name the unfulfilled checkout session, ${session.id}`);
      assert.ok(!log.includes(user.email), "the server log should not contain the customer's email");
    }
  });
}

test("a one-time purchase whose client_reference_id has no account is logged, not recorded", async () => {
  const id = crypto.randomUUID();
  const session = { id: `cs_test_${id}`, object: "checkout.session", mode: "payment" };
  stripe.add({ ...session, line_items: { object: "list", data: [{ quantity: 1, price: { id: "price_test_one_time" } }] } });
  await deliver({
    type: "checkout.session.completed",
    data: { object: { ...session, client_reference_id: crypto.randomUUID(), metadata: { type: "one_time_purchase" } } },
  });
  const { rows } = await db.query(`select 1 from purchases where stripe_checkout_session_id = $1`, [session.id]);
  assert.equal(rows.length, 0, "no purchase should be recorded");
  if (process.env.SERVER_LOG) {
    const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
    assert.match(log, new RegExp(`no account.*${session.id}`), `the server log should say ${session.id} has no account`);
  }
});

test("a one-time purchase sends no acknowledgment", async () => {
  await asNewUser(async (user) => {
    const id = crypto.randomUUID();
    stripe.add({
      id: `cs_test_${id}`,
      object: "checkout.session",
      mode: "payment",
      line_items: { object: "list", data: [{ quantity: 1, price: { id: "price_test_one_time" } }] },
    });
    await deliver({
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${id}`,
          object: "checkout.session",
          mode: "payment",
          client_reference_id: user.id,
          customer_details: { email: user.email },
          metadata: { type: "one_time_purchase" },
          amount_total: 1999,
          currency: "usd",
        },
      },
    });
    const { rows } = await db.query(`select 1 from purchases where stripe_checkout_session_id = $1`, [`cs_test_${id}`]);
    assert.equal(rows.length, 1, "the purchase should have been recorded, so the webhook did handle it");
    assert.equal(emailsTo(user).length, 0, "a one-time purchase should send no subscription acknowledgment");
  });
});

/**
 * Run `fn(baseUrl)` against a second copy of the app, on NO_RESEND_APP_PORT,
 * started from the same build with RESEND_API_KEY empty (an empty variable
 * wins over .env.local), and stop it again afterwards.
 */
async function withAppWithoutResend(fn) {
  const baseUrl = `http://localhost:${NO_RESEND_APP_PORT}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(NO_RESEND_APP_PORT)], {
    env: { ...process.env, RESEND_API_KEY: "" },
    stdio: "ignore",
    detached: true,
  });
  let spawnError;
  server.on("error", (e) => {
    spawnError = e;
  });
  try {
    for (let i = 0; ; i++) {
      if (spawnError) throw spawnError;
      if (await fetch(baseUrl).then(() => true, () => false)) break;
      if (i >= 60) assert.fail(`the second copy of the app did not answer on ${baseUrl} within 30s`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await fn(baseUrl);
  } finally {
    // A spawn that failed has no pid; killing it would throw and hide why.
    if (server.pid) process.kill(-server.pid);
  }
}

test("without Resend configured, the webhook still records the subscription and sends nothing", async () => {
  await withAppWithoutResend((baseUrl) =>
    asNewUser(async (user) => {
      const event = subscriptionCompleted(user, plan);
      await deliver(event, baseUrl);
      assert.ok(
        await subscriptionRecorded(event.data.object.subscription),
        "the subscription should have been recorded, so the webhook did handle it"
      );
      assert.equal(emailsTo(user).length, 0, "nothing should be sent without RESEND_API_KEY");
      assert.equal(
        await acknowledged(event.data.object.subscription),
        false,
        "with nothing sent, the subscription should not be recorded as acknowledged"
      );
    })
  );
});
