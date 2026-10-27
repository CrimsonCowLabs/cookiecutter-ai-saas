// The Content-Security-Policy lib/csp.ts builds for each response: scripts
// only by nonce, never 'unsafe-inline', 'unsafe-eval' only under `next dev`,
// nothing framed, and forms allowed to send the visitor only to the sign-in
// providers and payment pages this project was generated with — the real
// ones, or the stand-ins the compliance suite configures, never both.
//
// What browsers make of the policy is tests/compliance/
// content-security-policy.test.mjs's job; this is the policy as a string.
//
// No server: `npm run test:csp`. lib/csp.ts is loaded through tsx, as
// tests/rate-limit/client-key.test.mjs loads its module.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { parsePolicy } from "./parse-policy.mjs";

registerEsm();
registerCjs();
const csp = (await import("../../lib/csp.ts")).default;

// What this project was generated with, read off the tree as the compliance
// tests do (see tests/compliance/support.mjs's exists()).
const authConfig = fs.readFileSync("lib/auth.config.ts", "utf8");
const GOOGLE = authConfig.includes("providers/google");
const MICROSOFT = authConfig.includes("providers/microsoft-entra-id");
const STRIPE = fs.existsSync("lib/stripe.ts");

const production = (env = {}, nonce = "abc123") =>
  parsePolicy(csp.cspForRequest({ NODE_ENV: "production", ...env }, nonce).value);

test("scripts run only with the response's nonce, with no inline or eval escape hatch", () => {
  const policy = production();
  assert.deepEqual(policy["script-src"], ["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
  for (const [name, values] of Object.entries(policy)) {
    if (name === "style-src") continue;
    assert.ok(!values.includes("'unsafe-inline'"), `${name} allows 'unsafe-inline'`);
    assert.ok(!values.includes("'unsafe-eval'"), `${name} allows 'unsafe-eval'`);
  }
});

test("'unsafe-eval' is added under next dev only", () => {
  assert.deepEqual(parsePolicy(csp.cspForRequest({ NODE_ENV: "development" }, "n").value)["script-src"], [
    "'self'",
    "'nonce-n'",
    "'strict-dynamic'",
    "'unsafe-eval'",
  ]);
  assert.ok(!production({ NODE_ENV: "test" })["script-src"].includes("'unsafe-eval'"));
});

test("everything else is this origin, nothing embeds the app, and there are no plugins", () => {
  const policy = production();
  assert.deepEqual(policy["default-src"], ["'self'"]);
  assert.deepEqual(policy["connect-src"], ["'self'"]);
  assert.deepEqual(policy["font-src"], ["'self'"]);
  assert.deepEqual(policy["img-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'self'"]);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
});

test("violations are reported to the app's own endpoint, by report-uri alone", () => {
  const policy = parsePolicy(csp.cspForRequest({}, "n").value);
  assert.deepEqual(policy["report-uri"], ["/api/csp-report"]);
  // Given report-to as well, Chrome would ignore report-uri, and report only
  // from HTTPS pages, a minute late (see lib/csp.ts).
  assert.equal(policy["report-to"], undefined);
});

test("forms may send the visitor to this project's sign-in providers and payment pages, and nowhere else", () => {
  const expected = [
    "'self'",
    ...(GOOGLE ? ["https://accounts.google.com"] : []),
    ...(MICROSOFT ? ["https://login.microsoftonline.com"] : []),
    ...(STRIPE ? ["https://checkout.stripe.com", "https://billing.stripe.com"] : []),
  ];
  assert.deepEqual(production()["form-action"], expected);
});

test("a stand-in provider the app is pointed at replaces the real one, by origin", () => {
  const policy = production({
    AUTH_GOOGLE_ISSUER: "http://localhost:3999/google",
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: "http://localhost:3999/microsoft",
    STRIPE_API_BASE: "http://localhost:3998",
  });
  const expected = ["'self'", ...(GOOGLE || MICROSOFT ? ["http://localhost:3999"] : []), ...(STRIPE ? ["http://localhost:3998"] : [])];
  assert.deepEqual(policy["form-action"], expected);
});

test("a malformed or non-http override is ignored, not copied into the policy", () => {
  const policy = production({
    AUTH_GOOGLE_ISSUER: "javascript:alert(1)",
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: "not a url; script-src *",
    STRIPE_API_BASE: "data:text/html,x",
  });
  for (const value of policy["form-action"]) {
    assert.match(value, /^('self'|https:\/\/[a-z.]+)$/, `form-action took ${value}`);
  }
  assert.deepEqual(policy["script-src"], ["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
});

test("each request gets its own nonce", () => {
  const nonces = new Set(Array.from({ length: 50 }, () => csp.cspForRequest({}).nonce));
  assert.equal(nonces.size, 50);
  for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/, "128 bits, base64");
});

test("enforcing unless CSP_REPORT_ONLY=true", () => {
  assert.equal(csp.cspForRequest({}).name, "Content-Security-Policy");
  assert.equal(csp.cspForRequest({ CSP_REPORT_ONLY: "" }).name, "Content-Security-Policy");
  assert.equal(csp.cspForRequest({ CSP_REPORT_ONLY: "false" }).name, "Content-Security-Policy");
  assert.equal(csp.cspForRequest({ CSP_REPORT_ONLY: "true" }).name, "Content-Security-Policy-Report-Only");
  assert.equal(csp.cspForRequest({ CSP_REPORT_ONLY: " TRUE " }).name, "Content-Security-Policy-Report-Only");
});
