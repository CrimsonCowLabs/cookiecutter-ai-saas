// Marketing email meets CAN-SPAM by construction: lib/marketing-email.ts is
// the only way to send it, and it refuses to send without a real postal
// address, skips anyone who unsubscribed, and gives every email a footer with
// the unsubscribe link and the postal address plus both unsubscribe headers.
// See docs/compliance.md, "Marketing email".
//
// Nothing in the app sends marketing email by itself (that is the operator's
// to add), so there is no request to make to the running app that would
// send one. Instead this file loads the module itself, through tsx, and
// points its Resend client at a stand-in API (./fake-resend.mjs) that
// records every email. It shares the running app's database, and the
// unsubscribe link it sends is followed against the running app
// (scripts/check_compliance.sh boots one).
//
// Only ships in projects that send email at all (magic link, the contact
// form or Stripe).
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus FAKE_RESEND_PORT (see ./fake-resend.mjs).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { config, connectDb } from "../auth/support.mjs";
import { FAKE_RESEND_PORT, startFakeResend } from "./fake-resend.mjs";
import { unsubscribeToken } from "./support.mjs";

// What the module reads from the environment, set before it is loaded (the
// Resend client reads RESEND_BASE_URL as it loads). The secret and database
// are the running app's, so its links work there and its suppressions are
// the ones the app records.
Object.assign(process.env, {
  NEXTAUTH_URL: config.baseUrl,
  NEXTAUTH_SECRET: config.nextAuthSecret,
  DATABASE_URL: config.databaseUrl,
  RESEND_API_KEY: "re_test_0000000000000000000000000000",
  RESEND_BASE_URL: `http://localhost:${FAKE_RESEND_PORT}`,
});
// The project's .ts files are CommonJS to Node (package.json has no
// "type": "module"), so both of tsx's loaders are needed; either one
// resolves the "@/" imports through tsconfig.json.
registerEsm();
registerCjs();
// Each module's exports, as CommonJS hands them to an ESM import: always on
// `.default` (Node 22 also offers them as named exports, Node 20 does not).
// config.ts's own `export default` sits one level deeper. It is the same
// object the module reads, so a test can change its postal address.
const appConfig = (await import("../../config.ts")).default.default;
const { sendMarketingEmail } = (await import("../../lib/marketing-email.ts")).default;
const { db: moduleDb } = (await import("../../lib/db/index.ts")).default;

const POSTAL_ADDRESS = "123 Test Street, Suite 4, Testville, CA 90000, USA";
const placeholder = appConfig.legal.marketingPostalAddress;

let resend;
let db;
before(async () => {
  resend = await startFakeResend();
  db = await connectDb();
});
after(async () => {
  appConfig.legal.marketingPostalAddress = placeholder;
  await resend?.close();
  await db?.end();
  await moduleDb.$client.end();
});
beforeEach(() => {
  resend.emails.length = 0;
  appConfig.legal.marketingPostalAddress = POSTAL_ADDRESS;
});

const newAddress = () => `marketing-test-${crypto.randomUUID()}@example.invalid`;

async function forget(email) {
  await db.query("delete from email_suppressions where email = $1", [email.toLowerCase()]);
}

const message = (to) => ({
  to,
  subject: "What's new this month",
  senderName: "The Test Team",
  body: "Here is what we shipped this month.",
});

/** The <...> entries of a List-Unsubscribe header. */
const entries = (header) => [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]);

test("ships with a placeholder postal address, so out of the box nothing can be sent", () => {
  assert.match(placeholder, /^REPLACE_WITH_/);
});

test("refuses to send while the postal address is a placeholder", async () => {
  appConfig.legal.marketingPostalAddress = placeholder;
  await assert.rejects(sendMarketingEmail(message(newAddress())), /postal address/);
  assert.deepEqual(resend.emails, [], "nothing should have been sent");
});

test("skips a recipient who unsubscribed, however their address is written", async () => {
  const email = newAddress();
  try {
    await db.query("insert into email_suppressions (email, source) values ($1, 'test')", [email]);
    assert.equal(await sendMarketingEmail(message(`  ${email.toUpperCase()} `)), "suppressed");
    assert.deepEqual(resend.emails, [], "nothing should have been sent");
  } finally {
    await forget(email);
  }
});

test("sends with the footer and both unsubscribe headers, and its link unsubscribes", async () => {
  const email = newAddress();
  try {
    assert.equal(await sendMarketingEmail(message(email)), "sent");
    assert.equal(resend.emails.length, 1);
    const [sent] = resend.emails;
    assert.deepEqual([sent.to].flat(), [email]);
    assert.equal(sent.subject, "What's new this month");
    assert.match(sent.from, /^The Test Team <[^>]+@[^>]+>$/);

    const token = unsubscribeToken(email);
    const pageUrl = new URL(`/unsubscribe?token=${token}`, config.baseUrl).href;
    assert.ok(sent.text.startsWith("Here is what we shipped this month."), "the body should come first");
    assert.ok(sent.text.includes(`marketing email: ${pageUrl}`), `the footer should link to ${pageUrl}:\n${sent.text}`);
    assert.ok(sent.text.includes(POSTAL_ADDRESS), `the footer should carry the postal address:\n${sent.text}`);

    const [endpoint, mailto, ...rest] = entries(sent.headers["List-Unsubscribe"]);
    assert.deepEqual(rest, []);
    assert.equal(endpoint, new URL(`/api/unsubscribe?token=${token}`, config.baseUrl).href);
    assert.match(mailto, /^mailto:[^@?]+@[^?]+\?subject=unsubscribe$/);
    assert.equal(sent.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

    // What a mail client's unsubscribe button does with those headers.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: sent.headers["List-Unsubscribe-Post"],
    });
    assert.equal(res.status, 200);
    assert.equal(await sendMarketingEmail(message(email)), "suppressed");
    assert.equal(resend.emails.length, 1, "nothing more should have been sent after unsubscribing");
  } finally {
    await forget(email);
  }
});
