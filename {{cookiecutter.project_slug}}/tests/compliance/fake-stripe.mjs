// A stand-in for Stripe's API, so the renewal-terms tests can see exactly
// which Checkout Session the running app asks Stripe for, the acknowledgment
// tests can answer what the webhook looks up, and the checkout tests
// (tests/billing/integration/checkout.test.mjs) can count the customers and
// sessions the app creates, without a Stripe account or a network
// connection.
//
// scripts/check_compliance.sh and scripts/check_billing.sh boot the app with
// STRIPE_API_BASE pointing at http://localhost:<port> (see lib/stripe.ts), so
// the app's own Stripe client sends its requests here. What is answered:
//
//   - creating a Customer, recorded and handed back an id;
//   - creating a Checkout Session, recorded and handed back a checkout URL on
//     this server that the test browser never actually loads (every
//     off-origin request is aborted, see support.mjs's withPage()); listing a
//     customer's sessions, and expiring an open one;
//   - creating a billing portal session, recorded and handed back a URL here;
//   - listing a customer's subscriptions, out of those a test added;
//   - retrieving an object a test added beforehand, by its id, whatever its
//     type.
//
// Idempotency-Key headers are ignored, so every Customer the app asks for is
// a new one: what the checkout tests prove is that the app itself never asks
// twice, not that Stripe would have saved it.
//
// Zero dependencies: node:http only.
import http from "node:http";

export const FAKE_STRIPE_PORT = Number(process.env.FAKE_STRIPE_PORT || 3998);

// How long to wait for the app to create a session before failing.
const TIMEOUT_MS = 15_000;

// How long creating a Customer takes. Long enough that two requests the app
// sends at once are both in flight together, so a race between them shows.
const CUSTOMER_LATENCY_MS = 100;

/**
 * Start the fake API. Returns { nextCheckout, add, customers, checkouts,
 * portals, close }:
 *
 *   nextCheckout() — resolves with the parameters of the next Checkout
 *     Session the app creates, as Stripe receives them: a flat object of
 *     form fields, nested ones keyed the way Stripe encodes them
 *     (`custom_text[submit][message]`, `line_items[0][price]`).
 *
 *   add(...objects) — make each object retrievable by its `id`
 *     (GET /v1/<resource>/<id>), as Stripe would return it. A subscription
 *     added with a `customer` is also listed for that customer.
 *
 *   customers, checkouts, portals — every Customer, Checkout Session and
 *     billing portal session the app has created so far, in order:
 *     { id, params } plus, for a checkout, its `status` ("open" until
 *     expired).
 */
export async function startFakeStripe() {
  const waiting = [];
  const objects = new Map();
  const customers = [];
  const checkouts = [];
  const portals = [];
  let created = 0;

  const list = (data) => ({ object: "list", data, has_more: false, url: "" });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const url = new URL(req.url, "http://fake");
      const params = Object.fromEntries(new URLSearchParams(body));
      const route = `${req.method} ${url.pathname}`;

      if (route === "POST /v1/customers") {
        await new Promise((resolve) => setTimeout(resolve, CUSTOMER_LATENCY_MS));
        const customer = { id: `cus_fake_${++created}`, object: "customer", email: params.email ?? null };
        customers.push({ id: customer.id, params });
        objects.set(customer.id, customer);
        return json(200, customer);
      }
      if (route === "GET /v1/subscriptions") {
        const customer = url.searchParams.get("customer");
        return json(200, list([...objects.values()].filter((o) => o.object === "subscription" && o.customer === customer)));
      }
      if (route === "GET /v1/checkout/sessions") {
        const customer = url.searchParams.get("customer");
        const status = url.searchParams.get("status");
        return json(
          200,
          list(
            checkouts
              .filter((s) => s.params.customer === customer && (!status || s.status === status))
              .map(({ id, params, status }) => ({ id, object: "checkout.session", mode: params.mode, customer: params.customer, status }))
          )
        );
      }
      const expiring = route.match(/^POST \/v1\/checkout\/sessions\/([^/]+)\/expire$/);
      if (expiring) {
        const session = checkouts.find((s) => s.id === expiring[1]);
        if (!session || session.status !== "open") {
          return json(400, { error: { type: "invalid_request_error", message: `fake Stripe: ${expiring[1]} is not open` } });
        }
        session.status = "expired";
        return json(200, { id: session.id, object: "checkout.session", status: session.status });
      }
      if (route === "POST /v1/checkout/sessions") {
        const id = `cs_test_${++created}`;
        checkouts.push({ id, params, status: "open" });
        waiting.shift()?.(params);
        return json(200, { id, object: "checkout.session", url: `http://localhost:${FAKE_STRIPE_PORT}/pay/${id}` });
      }
      if (route === "POST /v1/billing_portal/sessions") {
        const id = `bps_test_${++created}`;
        portals.push({ id, params });
        return json(200, { id, object: "billing_portal.session", url: `http://localhost:${FAKE_STRIPE_PORT}/portal/${id}` });
      }

      const id = req.method === "GET" && url.pathname.split("/").pop();
      if (id && objects.has(id)) return json(200, objects.get(id));
      return json(404, { error: { type: "invalid_request_error", message: `fake Stripe: no ${req.method} ${req.url}` } });
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
    add(...added) {
      for (const object of added) objects.set(object.id, object);
    },
    customers,
    checkouts,
    portals,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
