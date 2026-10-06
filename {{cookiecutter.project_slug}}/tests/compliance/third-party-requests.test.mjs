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
import fs from "node:fs";
import {
  config,
  connectDb,
  insertTestUser,
  deleteTestUser,
  mintSessionCookie,
  launchBrowser,
  visit,
  describeOffOrigin,
  links,
} from "./support.mjs";

// The public pages a visitor can reach before signing in. /magic-link, /blog
// and /contact only exist for some answers at generation time
// (include_magic_link, include_marketing_extras); reading the tree rather than
// probing the URL means a page that should be there and 404s fails below
// instead of being quietly skipped. Paths are relative to the project root,
// which is where `npm run test:compliance` runs from.
const exists = (dir) => fs.existsSync(`app/(main)/${dir}`);
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

/** `index` plus every page under it that it links to. */
async function pagesUnder(index) {
  const html = await (await fetch(new URL(index, config.baseUrl))).text();
  return [index, ...new Set(links(html).filter((href) => href.startsWith(`${index}/`)))];
}

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
});

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
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      const cookie = await mintSessionCookie(user);
      await assertNoOffOriginRequests("/dashboard", { cookie });
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
});
