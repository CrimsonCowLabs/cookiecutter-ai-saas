// Customers see, and agree to, a subscription's auto-renewal terms right
// where they subscribe (California's Automatic Renewal Law) — run against a
// REALLY RUNNING app (scripts/check_compliance.sh boots one) in a real
// headless Chrome, with the app's Stripe client pointed at a stand-in API
// (./fake-stripe.mjs) so the Checkout Session it creates can be inspected.
// See docs/compliance.md, "Subscriptions and automatic renewal".
//
// Only ships in projects generated with Stripe.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus CHROME_PATH (see ./support.mjs) and
// FAKE_STRIPE_PORT (see ./fake-stripe.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectDb, insertTestUser, deleteTestUser, mintSessionCookie } from "../auth/support.mjs";
import { config, configuredPlans, launchBrowser, withPage, asSignedInUser, links } from "./support.mjs";
import { startFakeStripe } from "./fake-stripe.mjs";

const plans = configuredPlans();
const paidPlans = plans.filter((p) => p.price > 0);

/** The price as the terms should quote it: "$99", "$9.50", "€20". */
const formatPrice = ({ price, currency }) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
  }).format(price);

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
});

/**
 * Every button inside `scope` on the loaded page (anything styled as one,
 * link or not), with the plan whose card it is in (the nearest heading above
 * it), the text of whatever it is described by, whether that text sits in
 * the same element as the button, and its card's full text.
 */
function controls(page, scope) {
  return page.$$eval(`${scope} .btn`, (els) =>
    els.map((el) => {
      let card = el.parentElement;
      while (card && !card.querySelector("h3")) card = card.parentElement;
      const describedBy = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const terms = describedBy.map((id) => document.getElementById(id));
      return {
        label: el.textContent.trim(),
        plan: card?.querySelector("h3")?.textContent.trim(),
        cardText: card?.textContent ?? "",
        describedBy: terms.map((t) => t?.textContent.trim() ?? null),
        nextTo: terms.every((t) => t && el.parentElement.contains(t)),
      };
    })
  );
}

/** The renewal terms beside a control for `plan` say what they must. */
function assertTerms(control, plan, where) {
  const what = `"${control.label}" for ${plan.name} on ${where}`;
  assert.equal(control.describedBy.length, 1, `${what} should be linked to its renewal terms by aria-describedby`);
  const [terms] = control.describedBy;
  assert.ok(terms, `${what}: aria-describedby should name an element on the page`);
  assert.ok(control.nextTo, `${what}: the renewal terms should sit right next to it`);
  assert.match(terms, /renews automatically/i, `${what}: the terms should say it renews automatically (got "${terms}")`);
  assert.ok(terms.includes(formatPrice(plan)), `${what}: the terms should name the price, ${formatPrice(plan)} (got "${terms}")`);
  assert.match(terms, new RegExp(`\\b${plan.interval}\\b`), `${what}: the terms should name the interval, ${plan.interval} (got "${terms}")`);
  assert.match(terms, /cancel/i, `${what}: the terms should say how to cancel (got "${terms}")`);
}

function assertNoTerms(control, plan, where) {
  assert.equal(control.describedBy.length, 0, `"${control.label}" for the free ${plan.name} plan on ${where} should have no renewal terms`);
  assert.doesNotMatch(control.cardText, /renew/i, `the free ${plan.name} plan's card on ${where} should say nothing about renewal`);
}

test("every paid plan's button on the landing page has its renewal terms beside it, and free plans have none", async () => {
  await withPage(browser, "/", {}, async ({ page }) => {
    const found = await controls(page, "#pricing");
    for (const plan of plans) {
      const own = found.filter((c) => c.plan === plan.name);
      assert.ok(own.length > 0, `the landing page's pricing should have a button for ${plan.name}`);
      for (const control of own) {
        if (plan.price > 0) assertTerms(control, plan, "the landing page");
        else assertNoTerms(control, plan, "the landing page");
      }
    }
  });
});

test("every upgrade button in the dashboard settings has its renewal terms beside it", async () => {
  await asSignedInUser((cookie) =>
    withPage(browser, "/dashboard/settings", { cookie }, async ({ page }) => {
      const found = await controls(page, "#upgrade");
      for (const plan of paidPlans) {
        const own = found.filter((c) => c.plan === plan.name);
        assert.ok(own.length > 0, `the settings page should offer an upgrade to ${plan.name}`);
        for (const control of own) assertTerms(control, plan, "/dashboard/settings");
      }
      for (const control of found.filter((c) => !paidPlans.some((p) => p.name === c.plan))) {
        assert.fail(`"${control.label}" in the settings' upgrade section belongs to no paid plan`);
      }
    })
  );
});

/** The renewal terms shown beside `plan`'s upgrade button in the settings. */
async function termsOnSettings(page, plan) {
  const found = await controls(page, "#upgrade");
  return found.find((c) => c.plan === plan.name)?.describedBy[0];
}

function assertCheckout(params, plan, terms) {
  const what = `the Checkout Session for ${plan.name}`;
  assert.equal(params.mode, "subscription", `${what} should be a subscription`);
  assert.equal(
    params["custom_text[submit][message]"],
    terms,
    `${what} should show, beside its pay button, the same renewal terms as the app`
  );
  assert.equal(
    params["consent_collection[terms_of_service]"],
    "required",
    `${what} should require the customer to tick the terms-of-service box`
  );
}

test("a subscription's Stripe Checkout repeats the renewal terms and requires agreeing to the terms of service", async () => {
  const stripe = await startFakeStripe();
  try {
    await asSignedInUser(async (cookie) => {
      for (const plan of paidPlans) {
        await withPage(browser, "/dashboard/settings", { cookie }, async ({ page }) => {
          const terms = await termsOnSettings(page, plan);
          assert.ok(terms, `the settings should show ${plan.name}'s renewal terms`);
          const checkout = stripe.nextCheckout();
          await page.click(`#upgrade form:has(input[name="planId"][value="${plan.tier}"]) button[type="submit"]`);
          assertCheckout(await checkout, plan, terms);
        });
      }
    });
  } finally {
    await stripe.close();
  }
});

test("the checkout the app opens by itself after sign-up, for a plan picked beforehand, carries the same terms", async () => {
  const stripe = await startFakeStripe();
  try {
    await asSignedInUser(async (cookie) => {
      for (const plan of paidPlans) {
        const terms = await withPage(browser, "/dashboard/settings", { cookie }, ({ page }) => termsOnSettings(page, plan));
        const checkout = stripe.nextCheckout();
        // pending_plan_id is what /sign-up?plan_id=... leaves behind (see
        // lib/pending-plan.ts); the dashboard picks it up and checks out.
        await withPage(browser, "/dashboard", { cookie: [cookie, `pending_plan_id=${plan.tier}`] }, () => checkout);
        assertCheckout(await checkout, plan, terms);
      }
    });
  } finally {
    await stripe.close();
  }
});

test("the checkout the app opens by itself after sign-up sends someone already subscribed to the billing portal instead", async () => {
  // One live subscription per user (issue #72): a plan picked before signing
  // in to an account that already subscribes is changed in the portal, not
  // bought a second time.
  const [current, picked] = paidPlans;
  assert.ok(picked, "config.ts should list two paid plans");
  const stripe = await startFakeStripe();
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      const now = new Date();
      await db.query(
        `insert into subscriptions
           (user_id, stripe_subscription_id, stripe_price_id, plan, status, current_period_start, current_period_end)
         values ($1, $2, $3, $4, 'active', $5, $6)`,
        [user.id, `sub_test_${crypto.randomUUID()}`, current.priceId, current.tier, now, new Date(now.getTime() + 30 * 864e5)]
      );
      await db.query("update users set plan = $2 where id = $1", [user.id, current.tier]);
      const cookie = await mintSessionCookie(user);

      await withPage(browser, "/dashboard", { cookie: [cookie, `pending_plan_id=${picked.tier}`] }, async () => {
        for (let waited = 0; stripe.portals.length === 0 && waited < 15_000; waited += 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      assert.equal(stripe.portals.length, 1, "the app should open the billing portal for the plan change");
      assert.equal(stripe.checkouts.length, 0, "the app should open no Checkout Session");
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
    await stripe.close();
  }
});

test("the subscriptions page explains renewal, cancellation and refunds, and the Terms point to it", async () => {
  const res = await fetch(new URL("/legal/subscriptions", config.baseUrl));
  assert.equal(res.status, 200, `/legal/subscriptions should load unauthenticated, got ${res.status}`);
  const html = await res.text();
  for (const topic of [/renew/i, /cancel/i, /refund/i, /billing portal/i]) {
    assert.match(html, topic, `/legal/subscriptions should cover ${topic.source}`);
  }

  const hub = await (await fetch(new URL("/legal", config.baseUrl))).text();
  assert.ok(links(hub).includes("/legal/subscriptions"), "/legal should link to it");

  const tos = await (await fetch(new URL("/tos", config.baseUrl))).text();
  assert.match(tos, /automatic renewal/i, "the Terms of Service should have an automatic-renewal section");
  assert.ok(links(tos).includes("/legal/subscriptions"), "the Terms of Service should link to it");
});
