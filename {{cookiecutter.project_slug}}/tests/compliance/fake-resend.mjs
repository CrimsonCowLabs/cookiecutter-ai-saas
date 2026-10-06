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
 * Start the fake API. Returns { emails, close }:
 *
 *   emails — every email sent so far, in order, as the app sent it:
 *     { from, to, subject, text, ... } (`to` may be a string or a list).
 */
export async function startFakeResend() {
  const emails = [];

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
      emails.push(JSON.parse(body));
      json(200, { id: `email_test_${emails.length}` });
    });
  });
  await new Promise((resolve) => server.listen(FAKE_RESEND_PORT, resolve));

  return {
    emails,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
