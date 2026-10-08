// No page makes the visitor's browser contact another server before they have
// consented to it — run against a REALLY RUNNING app (scripts/check_compliance.sh
// boots one) in a real headless Chrome, because that is the only place the
// question has an answer. A font pulled from Google, a stylesheet from a CDN or
// a tracking pixel all compile, lint and render fine; they only show up as
// network requests a browser makes. See docs/compliance.md, "Fonts and
// third-party requests", for why this matters.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus CHROME_PATH (see ./support.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  launchBrowser,
  visit,
  describeOffOrigin,
  exists,
  pagesUnder,
  asSignedInUser,
  ageCheckCookie,
  // cc:begin resend
  unsubscribeToken,
  // cc:end resend
} from "./support.mjs";

// The public pages a visitor can reach before signing in. /magic-link, /blog
// and /contact only exist for some answers at generation time (see exists()).
const PUBLIC_PAGES = [
  "/",
  "/sign-in",
  "/sign-up",
  ...(exists("(auth)/magic-link") ? ["/magic-link"] : []),
  ...(exists("contact") ? ["/contact"] : []),
  "/privacy-policy",
  "/tos",
];

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
});

async function assertNoOffOriginRequests(path, options) {
  const { status, finalPath, offOrigin } = await visit(browser, path, options);
  assert.equal(status, 200, `${path} should load, got ${status}`);
  assert.equal(finalPath, path, `${path} should not redirect (ended on ${finalPath})`);
  assert.deepEqual(
    offOrigin,
    [],
    `${path} made the browser contact another server before consent:\n` +
      describeOffOrigin(path, offOrigin)
  );
}

test("public and auth pages make no off-origin requests", async () => {
  for (const path of PUBLIC_PAGES) {
    await assertNoOffOriginRequests(path);
  }
  // Bare /sign-up is the age screen; the sign-up buttons and form only show
  // once it has been passed.
  await assertNoOffOriginRequests("/sign-up", { cookie: await ageCheckCookie("1970-01-01") });
});

// cc:begin resend
test("the unsubscribe page makes no off-origin requests", async () => {
  // Opened from an email, by someone who may never have visited the site.
  const path = `/unsubscribe?token=${unsubscribeToken("third-party-test@example.invalid")}`;
  const { status, finalPath, offOrigin } = await visit(browser, path);
  assert.equal(status, 200, `/unsubscribe should load, got ${status}`);
  assert.equal(finalPath, "/unsubscribe", `/unsubscribe should not redirect (ended on ${finalPath})`);
  assert.deepEqual(offOrigin, [], describeOffOrigin("/unsubscribe", offOrigin));
});
// cc:end resend

test("legal pages make no off-origin requests", async () => {
  for (const path of await pagesUnder("/legal")) {
    await assertNoOffOriginRequests(path);
  }
});

test("blog pages make no off-origin requests", { skip: !exists("blog") && "no blog in this project" }, async () => {
  for (const path of await pagesUnder("/blog")) {
    await assertNoOffOriginRequests(path);
  }
});

test("the dashboard makes no off-origin requests", async () => {
  await asSignedInUser((cookie) => assertNoOffOriginRequests("/dashboard", { cookie }));
});
