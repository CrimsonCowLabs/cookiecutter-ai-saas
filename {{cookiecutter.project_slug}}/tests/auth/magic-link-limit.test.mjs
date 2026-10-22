// Magic-link sign-in emails are rate-limited (issue #106): a script that
// fetches a CSRF token and POSTs /api/auth/signin/resend in a loop gets no
// more than a few emails sent to any one address, nor many across addresses
// from one client, and sees the same "check your email" page either way.
// lib/auth.ts wraps the email provider in limitSignInLinks()
// (lib/magic-link-limit.ts), so this file loads that module itself, through
// tsx, wraps Auth.js's own Resend provider in it, and calls it the way
// Auth.js does, against a real Redis. Resend's API is never reached: fetch()
// is replaced, so every email the provider sends is recorded here.
//
// Needs only Redis: scripts/check_auth.sh in the template repository brings
// one up.
//
// Env vars (see tests/auth/support.mjs for defaults): REDIS_URL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Resend from "@auth/core/providers/resend";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { config } from "./support.mjs";

// Read by lib/redis when it first connects.
process.env.REDIS_URL = config.redisUrl;
// See tests/jobs/submission.test.mjs for why both of tsx's loaders.
registerEsm();
registerCjs();
const { limitSignInLinks, signInLinkLimits } = (await import("../../lib/magic-link-limit.ts")).default;
const { getRedis } = (await import("../../lib/redis.ts")).default;

const { perAddress, perIp } = signInLinkLimits;

// Every email sent to Resend's API, as { to }. Anything else fetched fails
// the test.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://api.resend.com/emails", "only Resend's API should be called");
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: `email_test_${sent.length}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

after(async () => {
  globalThis.fetch = realFetch;
  await getRedis().quit();
});

// New each call, so a re-run inside the window starts from nothing.
const newEmail = () => `magic-link-limit-${crypto.randomUUID()}@example.invalid`;
const newIp = () => `2001:db8::${crypto.randomBytes(2).toString("hex")}:${crypto.randomBytes(2).toString("hex")}`;

/**
 * The email provider as lib/auth.ts configures it: Auth.js's Resend, with
 * `options` as given (a sendVerificationRequest there is lib/auth.config.ts's
 * dev-mode logger), wrapped in the limit.
 */
const limitedResend = (options = {}) =>
  limitSignInLinks(Resend({ apiKey: "re_test_0000", from: "no-reply@example.invalid", ...options }));

/**
 * Ask `provider` for a sign-in link to `email` from `ip`, as Auth.js's
 * sendToken() does once the signIn callback lets the request through: the
 * provider it passes is the defaults with `options` merged over them.
 */
function requestLink(provider, email, ip) {
  const { options, ...defaults } = provider;
  const merged = { ...defaults, ...options };
  return merged.sendVerificationRequest({
    identifier: email,
    url: `http://localhost:3000/api/auth/callback/resend?token=t&email=${encodeURIComponent(email)}`,
    expires: new Date(Date.now() + 86_400_000),
    provider: merged,
    token: "t",
    theme: {},
    request: new Request("http://localhost:3000/api/auth/signin/resend", {
      method: "POST",
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
    }),
  });
}

const sentTo = (email) => sent.filter((e) => [e.to].flat().includes(email)).length;

test("the limits leave room to resend a link, and are tighter per address than per client", () => {
  assert.ok(perAddress >= 2, "someone who asks for a link and then again must get both");
  assert.ok(perIp > perAddress, "one client may sign in more than one address");
});

test(`one address gets at most ${perAddress} sign-in emails, however many clients ask`, async () => {
  const email = newEmail();
  const provider = limitedResend();
  for (let i = 0; i < perAddress + 3; i++) {
    // Each from its own client, so only the per-address limit applies. The
    // address as typed varies the way Auth.js leaves it alone: it is one
    // address however it is written.
    const typed = i % 2 ? ` ${email.toUpperCase()} ` : email;
    // Resolving (not throwing) is what keeps the response the same neutral
    // "check your email" page, sent or not.
    await requestLink(provider, typed, newIp());
  }
  const toThis = sent.filter((e) => [e.to].flat().some((to) => to.trim().toLowerCase() === email)).length;
  assert.equal(toThis, perAddress, `only the first ${perAddress} requests should send an email`);
});

test(`one client gets at most ${perIp} sign-in emails sent, across any number of addresses`, async () => {
  const ip = newIp();
  const provider = limitedResend();
  const emails = Array.from({ length: perIp + 5 }, newEmail);
  for (const email of emails) await requestLink(provider, email, ip);
  const delivered = emails.filter((email) => sentTo(email) > 0);
  assert.equal(delivered.length, perIp, `only the first ${perIp} addresses should be sent an email`);
  assert.deepEqual(delivered, emails.slice(0, perIp));

  // Another client is unaffected.
  const other = newEmail();
  await requestLink(provider, other, newIp());
  assert.equal(sentTo(other), 1, "a request from another client should still send");
});

test("signing in, and asking again, sends both links", async () => {
  const email = newEmail();
  const ip = newIp();
  const provider = limitedResend();
  await requestLink(provider, email, ip);
  await requestLink(provider, email, ip);
  assert.equal(sentTo(email), 2);
});

test("the dev-mode sender is limited too, and still called under the limit", async () => {
  const logged = [];
  const provider = limitedResend({
    sendVerificationRequest: async ({ identifier }) => {
      logged.push(identifier);
    },
  });
  const email = newEmail();
  const ip = newIp();
  for (let i = 0; i < perAddress + 2; i++) await requestLink(provider, email, ip);
  assert.equal(logged.length, perAddress);
  assert.equal(sentTo(email), 0, "the dev-mode sender replaces Resend; nothing should reach its API");
});

test("Redis keeps no address in the clear", async () => {
  const email = newEmail();
  const before = new Set(await getRedis().keys("rl:*"));
  await requestLink(limitedResend(), email, newIp());
  const added = (await getRedis().keys("rl:*")).filter((k) => !before.has(k));
  assert.ok(added.length > 0, "the request should be counted in Redis");
  const local = email.split("@")[0];
  assert.deepEqual(added.filter((k) => k.includes(local)), [], "no rate-limit key should hold the address");
});
