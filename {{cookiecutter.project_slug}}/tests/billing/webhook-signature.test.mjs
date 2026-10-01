// Webhook signature verification tests for the stripe-node upgrade (issue #26).
//
// This imports the installed "stripe" package directly as plain JS, not
// lib/stripe.ts: no TypeScript build step, and this is deleted entirely when
// a project is generated with include_stripe=no (see
// hooks/post_gen_project.py::handle_stripe), while the "stripe" npm
// dependency itself still ships either way (package.json isn't in the
// marker-substitution file-extension list — see app/api/webhook/stripe/route.ts's
// own comments for background). So this test has to work against the raw
// dependency alone, which is exactly what it needs to prove: the SDK's own
// signing/verification round-trip still works post-upgrade, independent of
// anything this repo's own billing code does with it.
//
// No network calls, no live keys: `new Stripe()` only throws for a missing/
// malformed-looking key when a request is actually made, and
// webhooks.constructEvent/generateTestHeaderString are pure local HMAC
// operations, so a dummy test key is sufficient (see
// node_modules/stripe/cjs/Webhooks.d.ts for both signatures).
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";

const DUMMY_SECRET_KEY = "sk_test_dummy_key_for_offline_signature_tests";
const DUMMY_WEBHOOK_SECRET = "whsec_dummy_test_secret";

const stripe = new Stripe(DUMMY_SECRET_KEY, { typescript: true });

function fakeCheckoutCompletedPayload() {
  return JSON.stringify({
    id: "evt_test_webhook",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        object: "checkout.session",
        client_reference_id: "user_123",
      },
    },
  });
}

test("a correctly signed payload verifies and round-trips the event type", () => {
  const payload = fakeCheckoutCompletedPayload();
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: DUMMY_WEBHOOK_SECRET,
  });

  const event = stripe.webhooks.constructEvent(
    payload,
    signature,
    DUMMY_WEBHOOK_SECRET
  );

  assert.equal(event.type, "checkout.session.completed");
  assert.equal(event.data.object.id, "cs_test_123");
});

test("a tampered payload is rejected even with a validly-formed signature", () => {
  const payload = fakeCheckoutCompletedPayload();
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: DUMMY_WEBHOOK_SECRET,
  });

  const tamperedPayload = payload.replace("user_123", "user_attacker");

  assert.throws(() => {
    stripe.webhooks.constructEvent(
      tamperedPayload,
      signature,
      DUMMY_WEBHOOK_SECRET
    );
  }, Stripe.errors.StripeSignatureVerificationError);
});

test("a signature computed with the wrong secret is rejected", () => {
  const payload = fakeCheckoutCompletedPayload();
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_a_different_secret",
  });

  assert.throws(() => {
    stripe.webhooks.constructEvent(payload, signature, DUMMY_WEBHOOK_SECRET);
  }, Stripe.errors.StripeSignatureVerificationError);
});
