// Shared helpers for tests/compliance/*.test.mjs — kept separate so each test
// file reads as a list of things a visitor (or a regulator) could observe, not
// plumbing.
//
// The database and session helpers are the auth suite's own (see
// tests/auth/support.mjs): scripts/check_compliance.sh boots the app with the
// same NEXTAUTH_SECRET and DATABASE_URL that scripts/check_auth.sh does, so a
// cookie minted there is one this app accepts here too.
// cc:begin resend
import crypto from "node:crypto";
// cc:end resend
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import {
  config,
  connectDb,
  insertTestUser,
  deleteTestUser,
  mintSessionCookie,
} from "../auth/support.mjs";

export { config };

// Hosts that Google Fonts is served from. A request to either is the exact
// thing a Munich court fined a site for (LG München I, 3 O 17493/20), and the
// easiest way to bring it back is pasting the <link> tags Google's own font
// picker hands out — so a failure naming one of these says so, and says what
// to do instead.
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

// Common install locations, tried in order when CHROME_PATH is unset.
// puppeteer-core never downloads a browser of its own, which is the point of
// using it over puppeteer: nothing here fetches anything at install time.
const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** legal.minimumAge, read out of config.ts (the project root is the cwd). */
export function minimumAge() {
  const value = Number(fs.readFileSync("config.ts", "utf8").match(/minimumAge:\s*(\d+)/)?.[1]);
  if (!(value > 0)) throw new Error("config.ts should set legal.minimumAge to a number");
  return value;
}

/**
 * The string value of `key` inside the `legal.<block>` block of config.ts.
 *
 * The value may be any string literal an operator would write: double- or
 * single-quoted with escapes (a multi-line postal address as "…\n…"), or a
 * template literal without `${}`. It is evaluated as the literal it is, so
 * "\n" becomes the newline the page actually renders.
 */
export function legalConfig(block, key) {
  const body = fs.readFileSync("config.ts", "utf8").match(new RegExp(`${block}:\\s*\\{([^}]*)\\}`))?.[1];
  const literal = body?.match(
    new RegExp(`${key}:\\s*("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`[^\`$\\\\]*\`)`)
  )?.[1];
  if (!literal) throw new Error(`config.ts should set legal.${block}.${key} to a string`);
  return new Function(`return ${literal};`)();
}

/**
 * `html` with the character references React writes for text and attribute
 * values turned back into the characters, so a value with `&`, `'` or `"` in
 * it can be compared as written.
 */
export function unescapeHtml(html) {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// cc:begin stripe
/**
 * config.stripe.plans, read out of config.ts (the project root is the cwd):
 * [{ tier, name, price, currency, interval, priceId }]. `priceId` is the live
 * one where config.ts picks by environment, since `next start` runs with
 * NODE_ENV=production.
 */
export function configuredPlans() {
  const source = fs.readFileSync("config.ts", "utf8");
  const plans = [
    ...source.matchAll(
      /tier: "(\w+)",[\s\S]*?priceId:\s*(?:process\.env\.NODE_ENV === "production"\s*\?\s*)?"([^"]*)",?[\s\S]*?name: "([^"]+)",[\s\S]*?price: ([\d.]+),[\s\S]*?currency: "(\w+)",[\s\S]*?interval: "(\w+)"/g
    ),
  ].map(([, tier, priceId, name, price, currency, interval]) => ({
    tier,
    name,
    price: Number(price),
    currency,
    interval,
    priceId,
  }));
  if (plans.length === 0) {
    throw new Error("config.ts should list plans with a tier, priceId, name, price, currency and interval");
  }
  return plans;
}
// cc:end stripe

// cc:begin resend
/**
 * The token in `email`'s unsubscribe links, signed the way lib/unsubscribe.ts
 * signs it, with the NEXTAUTH_SECRET the app was booted with.
 */
export function unsubscribeToken(email) {
  const address = email.trim().toLowerCase();
  const signature = crypto
    .createHmac("sha256", config.nextAuthSecret)
    .update(`unsubscribe:${address}`)
    .digest("base64url");
  return `${Buffer.from(address).toString("base64url")}.${signature}`;
}
// cc:end resend

/** Every same-site `href` in `html`, without its query or fragment. */
export function links(html) {
  return [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
}

/**
 * Whether `app/(main)/<dir>` is in this project. Some pages only exist for
 * some answers at generation time (include_magic_link, include_stripe,
 * include_marketing_extras); reading the tree rather than probing the URL
 * means a page that should be there and 404s fails a test instead of being
 * quietly skipped. Paths are relative to the project root, which is where
 * `npm run test:compliance` runs from.
 */
export const exists = (dir) => fs.existsSync(`app/(main)/${dir}`);

/** `index` plus every page under it that it links to. */
export async function pagesUnder(index) {
  const html = await (await fetch(new URL(index, config.baseUrl))).text();
  return [index, ...new Set(links(html).filter((href) => href.startsWith(`${index}/`)))];
}

/**
 * Run `fn(cookie)` as a freshly inserted user, signed in with a session
 * cookie minted for them, and delete the user again afterwards.
 */
export async function asSignedInUser(fn) {
  const db = await connectDb();
  try {
    const user = await insertTestUser(db);
    try {
      return await fn(await mintSessionCookie(user));
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
}

/**
 * A `Cookie:` header value for a visitor who has answered the age screen on
 * /sign-up with `dateOfBirth` (YYYY-MM-DD): passed, or turned away. See
 * ./age-gate.test.mjs for the screen itself.
 */
export async function ageCheckCookie(dateOfBirth) {
  const res = await fetch(new URL("/api/age-check", config.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ dateOfBirth }),
  });
  const cookie = res.headers.getSetCookie().find((c) => !/^[^=]+=;|max-age=0/i.test(c));
  if (!cookie) throw new Error(`answering the age screen with ${dateOfBirth} set no cookie (${res.status})`);
  return cookie.split(";")[0];
}

export async function launchBrowser() {
  const executablePath =
    process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    throw new Error(
      "No Chrome/Chromium found. Set CHROME_PATH to a Chrome or Chromium binary."
    );
  }
  return puppeteer.launch({
    executablePath,
    // The browser only ever loads this app on localhost, and every off-origin
    // request is aborted before it leaves (see visit() below), so Chrome's
    // own sandbox protects nothing here — and it refuses to start without
    // user namespaces, which CI runners and containers often lack.
    args: ["--no-sandbox"],
  });
}

/**
 * Load `path` in a fresh page with no consent given, hand the loaded page to
 * `fn`, and close it again once `fn` is done. `cookie` is one `name=value`
 * or a list of them. Every request the page tries to
 * make to another origin is aborted before it is sent, so nothing a test
 * does here ever leaks anything, and is recorded in the `offOrigin` list
 * passed to `fn` (see visit() below for its shape).
 *
 * Returns whatever `fn` returns.
 */
export async function withPage(browser, path, { cookie } = {}, fn) {
  const base = new URL(config.baseUrl);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const offOrigin = [];
  try {
    for (const c of [cookie ?? []].flat()) {
      const [name, ...rest] = c.split("=");
      await context.setCookie({ name, value: rest.join("="), domain: base.hostname, path: "/" });
    }

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = new URL(req.url());
      const isNetwork = ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
      if (isNetwork && url.host !== base.host) {
        offOrigin.push({ host: url.hostname, url: url.href, kind: req.resourceType() });
        req.abort("blockedbyclient");
        return;
      }
      req.continue();
    });

    const res = await page.goto(new URL(path, base).href, { waitUntil: "networkidle0" });
    return await fn({ page, res, offOrigin });
  } finally {
    await context.close();
  }
}

/**
 * Load `path` in a fresh page with no consent given, and report every request
 * the page tried to make to another origin. Each such request is aborted
 * before it is sent, so the check itself never leaks anything.
 *
 * Returns { status, finalPath, offOrigin }, where offOrigin is a list of
 * { host, url, kind } — kind is the resource type ("stylesheet", "font",
 * "script", ...) or "preconnect"/"dns-prefetch" for <link> hints, which open
 * a connection (and so send the visitor's IP address) without ever showing up
 * as a request.
 */
export async function visit(browser, path, options = {}) {
  const base = new URL(config.baseUrl);
  return withPage(browser, path, options, async ({ page, res, offOrigin }) => {
    // Anything loaded lazily (images below the fold, intersection-observed
    // embeds) only asks for itself once it is scrolled into view.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForNetworkIdle({ idleTime: 300 });

    const hints = await page.$$eval(
      'link[rel~="preconnect"], link[rel~="dns-prefetch"]',
      (els) => els.map((l) => ({ href: l.href, rel: l.rel }))
    );
    for (const { href, rel } of hints) {
      const url = new URL(href, base);
      if (url.host !== base.host) {
        offOrigin.push({ host: url.hostname, url: url.href, kind: rel });
      }
    }

    return { status: res?.status() ?? 0, finalPath: new URL(page.url()).pathname, offOrigin };
  });
}

/** One human-readable line per off-origin request, font hosts called out. */
export function describeOffOrigin(path, offOrigin) {
  return offOrigin
    .map(({ host, url, kind }) => {
      const why = FONT_HOSTS.has(host)
        ? " — a Google Fonts host: this sends the visitor's IP address to Google. Load the font with next/font instead, which serves it from this app's own domain"
        : "";
      return `${path} contacted ${host} (${kind}: ${url})${why}`;
    })
    .join("\n");
}
