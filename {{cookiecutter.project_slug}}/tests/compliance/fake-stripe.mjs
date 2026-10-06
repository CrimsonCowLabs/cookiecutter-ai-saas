// A stand-in for Stripe's API, so the renewal-terms tests can see exactly
// which Checkout Session the running app asks Stripe for, without a Stripe
// account or a network connection.
//
// scripts/check_compliance.sh boots the app with STRIPE_API_BASE pointing at
// http://localhost:<port> (see lib/stripe.ts), so the app's own Stripe client
// sends its requests here. Only creating a Checkout Session is answered: the
// request is recorded and the app is handed back a checkout URL on this
// server, which the test browser never actually loads (every off-origin
// request is aborted, see support.mjs's withPage()).
//
// Zero dependencies: node:http only.
import http from "node:http";

export const FAKE_STRIPE_PORT = Number(process.env.FAKE_STRIPE_PORT || 3998);

// How long to wait for the app to create a session before failing.
const TIMEOUT_MS = 15_000;

/**
 * Start the fake API. Returns { nextCheckout, close }:
 *
 *   nextCheckout() — resolves with the parameters of the next Checkout
 *     Session the app creates, as Stripe receives them: a flat object of
 *     form fields, nested ones keyed the way Stripe encodes them
 *     (`custom_text[submit][message]`, `line_items[0][price]`).
 */
export async function startFakeStripe() {
  const waiting = [];
  let created = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method !== "POST" || req.url !== "/v1/checkout/sessions") {
        return json(404, { error: { type: "invalid_request_error", message: `fake Stripe: no ${req.method} ${req.url}` } });
      }
      const params = Object.fromEntries(new URLSearchParams(body));
      const id = `cs_test_${++created}`;
      waiting.shift()?.(params);
      json(200, { id, object: "checkout.session", url: `http://localhost:${FAKE_STRIPE_PORT}/pay/${id}` });
    });
  });
  await new Promise((resolve) => server.listen(FAKE_STRIPE_PORT, resolve));

  return {
    // Call it before doing whatever should create the session.
    nextCheckout() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the app created no Stripe Checkout Session within ${TIMEOUT_MS / 1000}s`)),
          TIMEOUT_MS
        );
        waiting.push((params) => {
          clearTimeout(timer);
          resolve(params);
        });
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
