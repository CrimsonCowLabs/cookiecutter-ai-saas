// A stand-in for Resend's API, so the acknowledgment-email tests can read
// every email the running app sends, without a Resend account or a network
// connection.
//
// scripts/check_compliance.sh boots the app with RESEND_BASE_URL pointing at
// http://localhost:<port> (the resend package reads it; production leaves it
// unset), so the app's own Resend client sends its emails here. Each one is
// recorded and answered the way Resend answers a sent email.
//
// Zero dependencies: node:http only.
import http from "node:http";

export const FAKE_RESEND_PORT = Number(process.env.FAKE_RESEND_PORT || 3997);

/**
 * Start the fake API. Returns { emails, failNext, close }:
 *
 *   emails — every email sent so far, in order, as the app sent it:
 *     { from, to, subject, text, ... } (`to` may be a string or a list),
 *     plus `idempotencyKey`, the request's Idempotency-Key header (or null).
 *   failNext(count = 1) — answer the next `count` sends with a 500, the way
 *     Resend answers when it is down, recording nothing.
 *
 * Like Resend, a send repeating an earlier one's Idempotency-Key is answered
 * with that earlier send's id and not sent again (or a 409, if its body
 * differs). Resend forgets keys after 24 hours; a test run never gets there.
 */
export async function startFakeResend() {
  const emails = [];
  const byKey = new Map();
  let failures = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method !== "POST" || req.url !== "/emails") {
        return json(404, { name: "not_found", message: `fake Resend: no ${req.method} ${req.url}` });
      }
      if (failures > 0) {
        failures--;
        return json(500, { name: "internal_server_error", message: "fake Resend: failing on purpose", statusCode: 500 });
      }
      const idempotencyKey = req.headers["idempotency-key"] ?? null;
      const earlier = idempotencyKey && byKey.get(idempotencyKey);
      if (earlier) {
        if (earlier.body !== body) {
          return json(409, { name: "invalid_idempotent_request", message: "fake Resend: same key, different body", statusCode: 409 });
        }
        return json(200, { id: earlier.id });
      }
      emails.push({ ...JSON.parse(body), idempotencyKey });
      const id = `email_test_${emails.length}`;
      if (idempotencyKey) byKey.set(idempotencyKey, { body, id });
      json(200, { id });
    });
  });
  await new Promise((resolve) => server.listen(FAKE_RESEND_PORT, resolve));

  return {
    emails,
    failNext: (count = 1) => {
      failures = count;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
