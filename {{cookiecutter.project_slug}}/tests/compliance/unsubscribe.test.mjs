// Anyone sent marketing email can always unsubscribe (CAN-SPAM) — run against
// a REALLY RUNNING app (scripts/check_compliance.sh boots one). The link in
// every marketing email's footer opens a confirmation page with one button;
// the List-Unsubscribe header's URL takes RFC 8058 one-click POSTs from mail
// clients. Either way the address lands in email_suppressions, which
// lib/marketing-email.ts checks before every send. See docs/compliance.md,
// "Marketing email".
//
// Only ships in projects that send email at all (magic link, the contact
// form or Stripe).
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config, connectDb } from "../auth/support.mjs";
import { unsubscribeToken } from "./support.mjs";

let db;
before(async () => {
  db = await connectDb();
});
after(async () => {
  await db?.end();
});

/** A fresh address, in mixed case to prove it is stored normalised. */
const newAddress = () => `Unsubscribe-Test-${crypto.randomUUID()}@Example.invalid`;

/** Every email_suppressions row for `email`, stored normalised. */
async function suppressions(email) {
  const { rows } = await db.query(
    "select email, source, suppressed_at from email_suppressions where email = $1",
    [email.trim().toLowerCase()]
  );
  return rows;
}

async function forget(email) {
  await db.query("delete from email_suppressions where email = $1", [email.trim().toLowerCase()]);
}

const url = (path) => new URL(path, config.baseUrl);

/** POST the confirmation page's form, the way a browser without JavaScript would. */
const postForm = (token) =>
  fetch(url("/api/unsubscribe"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });

/** POST what a mail client sends for RFC 8058 one-click, to the header's URL. */
const postOneClick = (token) =>
  fetch(url(`/api/unsubscribe?token=${encodeURIComponent(token)}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

/** The text a visitor would read on `html`, roughly. */
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

/** `token` with one character of its signature changed. */
const tampered = (token) => token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

test("the footer link's GET shows a confirmation page with one button, and changes nothing", async () => {
  const email = newAddress();
  const res = await fetch(url(`/unsubscribe?token=${unsubscribeToken(email)}`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(text(html), /Unsubscribe from marketing email/);

  const forms = [...html.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
  assert.equal(forms.length, 1, "the page should have exactly one form");
  assert.match(forms[0], /method="post"/i);
  assert.match(forms[0], /action="\/api\/unsubscribe"/);
  assert.equal([...html.matchAll(/<button\b/g)].length, 1, "the page should have exactly one button");
  assert.deepEqual(await suppressions(email), [], "opening the page must not unsubscribe anyone");
});

test("the List-Unsubscribe URL's GET leads to the same confirmation page", async () => {
  const email = newAddress();
  const token = unsubscribeToken(email);
  const res = await fetch(url(`/api/unsubscribe?token=${token}`), { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/unsubscribe?token=${token}`);
  assert.deepEqual(await suppressions(email), [], "a GET must not unsubscribe anyone");
});

test("the confirmation form's POST unsubscribes the address, once", async () => {
  const email = newAddress();
  try {
    const token = unsubscribeToken(email);
    const res = await postForm(token);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/unsubscribe?status=done");
    const done = await (await fetch(url("/unsubscribe?status=done"))).text();
    assert.match(text(done), /You are unsubscribed/);

    const [row, ...more] = await suppressions(email);
    assert.deepEqual(more, []);
    assert.equal(row.email, email.toLowerCase());
    assert.equal(row.source, "unsubscribe-page");

    const again = await postForm(token);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get("location"), "/unsubscribe?status=done");
    assert.deepEqual(await suppressions(email), [row], "repeating the request should change nothing");
  } finally {
    await forget(email);
  }
});

test("a one-click POST unsubscribes the address, once", async () => {
  const email = newAddress();
  try {
    const token = unsubscribeToken(email);
    const res = await postOneClick(token);
    assert.equal(res.status, 200);

    const [row, ...more] = await suppressions(email);
    assert.deepEqual(more, []);
    assert.equal(row.source, "one-click");

    assert.equal((await postOneClick(token)).status, 200);
    // The form after a one-click is a repeat too: the first opt-out stands.
    assert.equal((await postForm(token)).status, 303);
    assert.deepEqual(await suppressions(email), [row], "repeating the request should change nothing");
  } finally {
    await forget(email);
  }
});

test("a tampered token is rejected, everywhere, and unsubscribes no one", async () => {
  const email = newAddress();
  const bad = tampered(unsubscribeToken(email));
  // The signature is right but for another address: swapping the address
  // part must not work either.
  const otherEmail = newAddress();
  const [, signature] = unsubscribeToken(email).split(".");
  const other = `${Buffer.from(otherEmail.toLowerCase()).toString("base64url")}.${signature}`;

  for (const token of [bad, other, "", "not-a-token"]) {
    const page = await fetch(url(`/unsubscribe?token=${encodeURIComponent(token)}`));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(text(html), /This unsubscribe link is not valid/);
    assert.doesNotMatch(html, /<form/, "a page for a bad link should offer no button");

    const form = await postForm(token);
    assert.equal(form.status, 303);
    assert.equal(form.headers.get("location"), "/unsubscribe?status=invalid");

    assert.equal((await postOneClick(token)).status, 400);
  }
  assert.deepEqual(await suppressions(email), [], "no address should have been unsubscribed");
  assert.deepEqual(await suppressions(otherEmail), [], "no address should have been unsubscribed");
});

test("the response never reveals whether the address has an account", async () => {
  const { rows: [user] = [] } = await db.query(
    "insert into users (email, name) values ($1, 'Unsubscribe Test') returning id, email",
    [`unsubscribe-test-${crypto.randomUUID()}@example.invalid`]
  );
  const stranger = newAddress();
  try {
    const answers = [];
    for (const email of [user.email, stranger]) {
      const token = unsubscribeToken(email);
      const page = text(await (await fetch(url(`/unsubscribe?token=${token}`))).text()).replaceAll(token, "");
      const form = await postForm(token);
      const oneClick = await postOneClick(token);
      answers.push({
        page: page.replace(/self\.__next_f[\s\S]*/, ""),
        form: [form.status, form.headers.get("location")],
        oneClick: [oneClick.status, await oneClick.text()],
      });
    }
    assert.deepEqual(answers[0], answers[1]);
  } finally {
    await db.query("delete from users where id = $1", [user.id]);
    await forget(user.email);
    await forget(stranger);
  }
});

test("an unsubscribed address stays unsubscribed after its account is deleted", async () => {
  const { rows: [user] } = await db.query(
    "insert into users (email, name) values ($1, 'Unsubscribe Test') returning id, email",
    [`unsubscribe-test-${crypto.randomUUID()}@example.invalid`]
  );
  try {
    assert.equal((await postForm(unsubscribeToken(user.email))).status, 303);
    await db.query("delete from users where id = $1", [user.id]);
    assert.equal((await suppressions(user.email)).length, 1);
  } finally {
    await db.query("delete from users where id = $1", [user.id]);
    await forget(user.email);
  }
});
