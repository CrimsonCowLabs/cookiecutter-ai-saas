// clientKey() (lib/rate-limit.ts) is the bucket every per-client rate limit
// counts a request in: the contact form's, and with magic link included, the
// sign-in email limit's, whose own tests hold it to this end to end; this file
// ships either way. Caddy's own limits count an IPv6 client by its /64
// (ipv6_prefix 64 in the Caddyfile), because one subscriber is handed a whole
// /64 and can send each request from a fresh address in it; the app's limits
// must count the same way, or rotating addresses buys a fresh limit each time.
//
// No server, no Redis: `npm run test:rate-limit`. lib/rate-limit.ts is loaded
// through tsx, as tests/jobs/submission.test.mjs loads its modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

registerEsm();
registerCjs();
const { clientKey } = (await import("../../lib/rate-limit.ts")).default;

const keyFor = (xff) => clientKey(new Headers(xff === undefined ? {} : { "x-forwarded-for": xff }));

test("an IPv4 client counts by its own address, the first X-Forwarded-For entry", () => {
  assert.equal(keyFor("203.0.113.7"), "203.0.113.7");
  assert.equal(keyFor("203.0.113.7, 10.0.0.1"), "203.0.113.7");
  assert.equal(keyFor(" 203.0.113.7 ,10.0.0.1"), "203.0.113.7");
  assert.notEqual(keyFor("203.0.113.7"), keyFor("203.0.113.8"));
});

test("an IPv6 client counts by its /64, however the address is written", () => {
  const key = keyFor("2001:db8:1:2::1");
  for (const ip of [
    "2001:db8:1:2::ffff",
    "2001:0db8:0001:0002:0000:0000:0000:0001",
    "2001:DB8:1:2:AAAA:BBBB:CCCC:DDDD",
    "2001:db8:1:2:a::",
    "2001:db8:1:2:0:0:198.51.100.1",
    " 2001:db8:1:2::9 , 10.0.0.1",
  ]) {
    assert.equal(keyFor(ip), key, ip);
  }
  assert.notEqual(keyFor("2001:db8:1:3::1"), key, "the next /64 is another client");
  assert.notEqual(keyFor("2001:db8:2:2::1"), key);
  assert.notEqual(keyFor("2001:db8:1:2::1"), keyFor("2001:db8:1::2:0:0:1"), ":: stands for zeros where it sits");
  assert.equal(keyFor("::"), keyFor("::1"));
  assert.notEqual(keyFor("::"), keyFor("1::"));
});

test("an IPv4-mapped IPv6 address counts as the IPv4 address it carries", () => {
  assert.equal(keyFor("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(keyFor("::FFFF:cb00:7107"), "203.0.113.7");
  assert.equal(keyFor("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  // All of them sit in one /64, so counting them by it would make the whole
  // IPv4 internet one client.
  assert.notEqual(keyFor("::ffff:203.0.113.7"), keyFor("::ffff:203.0.113.8"));
});

test("a request with no client address counts in one shared bucket", () => {
  assert.equal(keyFor(undefined), "unknown");
  assert.equal(keyFor(""), "unknown");
  assert.equal(keyFor(" , 10.0.0.1"), "unknown");
});
