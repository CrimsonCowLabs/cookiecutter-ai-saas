// Every page is sent with a Content-Security-Policy that lets a script run
// only with the nonce made for that response, and the app's normal flows
// never trip it — run against a REALLY RUNNING app (scripts/check_compliance.sh
// boots one) in a real headless Chrome, because only a browser enforces a
// policy, and only a browser running the page's real scripts shows whether
// the policy breaks them. See docs/content-security-policy.md.
//
// The policy itself is built by lib/csp.ts and held to its rules, as a
// string, by tests/csp/policy.test.mjs. This file checks what browsers make
// of it: every page carries it with a fresh nonce; the normal flows (landing,
// signing up and in, the dashboard, a job's report, and checkout and
// accepting analytics where the project has them) run without one
// violation; and a script injected into a page without the nonce does not
// run, and is reported to app/api/csp-report/route.ts.
//
// The stand-in identity provider (./fake-oidc.mjs) runs here, as do
// cc:begin stripe
// the stand-in Stripe (./fake-stripe.mjs) and
// cc:end stripe
// cc:begin analytics
// the stand-in PostHog (./fake-posthog.mjs) and
// cc:end analytics
// nothing else. The app is pointed at them, so the policy names their
// origins where production's names the real ones (see lib/csp.ts).
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL, FAKE_OIDC_PORT and SERVER_LOG, plus the
// stand-ins' ports; and CHROME_PATH (see ./support.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  config,
  launchBrowser,
  withPage,
  exists,
  pagesUnder,
  asSignedInUser,
  ageCheckCookie,
  // cc:begin analytics
  sessionReplay,
  // cc:end analytics
} from "./support.mjs";
import { connectDb } from "../auth/support.mjs";
import { parsePolicy } from "../csp/parse-policy.mjs";
import { startFakeOidc, FAKE_OIDC_PORT } from "./fake-oidc.mjs";
// cc:begin stripe
import { startFakeStripe, FAKE_STRIPE_PORT } from "./fake-stripe.mjs";
// cc:end stripe
// cc:begin analytics
import { startFakePostHog } from "./fake-posthog.mjs";
// cc:end analytics

const BASE = new URL(config.baseUrl);

// The public pages a visitor reaches before signing in. /magic-link, /blog
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
let idp;
// cc:begin stripe
let stripe;
// cc:end stripe
// cc:begin analytics
let posthog;
// cc:end analytics
before(async () => {
  idp = await startFakeOidc();
  // cc:begin stripe
  stripe = await startFakeStripe();
  // cc:end stripe
  // cc:begin analytics
  posthog = await startFakePostHog();
  // cc:end analytics
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await idp?.close();
  // cc:begin stripe
  await stripe?.close();
  // cc:end stripe
  // cc:begin analytics
  await posthog?.close();
  // cc:end analytics
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a click that should leave the page gets to do it.
const NAVIGATION_TIMEOUT_MS = 15_000;

/** The nonce script-src names in `header`, or null. */
const nonceIn = (header) => header?.match(/'nonce-([^']+)'/)?.[1] ?? null;

/**
 * Assert `res` carries an enforcing policy whose scripts need a nonce, and
 * return that nonce.
 */
function assertEnforcing(res, what) {
  const header = res.headers.get("content-security-policy");
  assert.ok(header, `${what} should carry a Content-Security-Policy header`);
  assert.equal(
    res.headers.get("content-security-policy-report-only"),
    null,
    `${what} should enforce its policy, not only report (is CSP_REPORT_ONLY set?)`
  );
  const policy = parsePolicy(header);
  const scripts = policy["script-src"] ?? policy["default-src"];
  assert.ok(scripts, `${what}: the policy should restrict scripts`);
  assert.ok(!scripts.includes("'unsafe-inline'"), `${what}: script-src allows 'unsafe-inline'`);
  assert.ok(!scripts.includes("'unsafe-eval'"), `${what}: script-src allows 'unsafe-eval'`);
  assert.ok(!scripts.some((s) => s === "*" || /^(https?|data|blob):$/.test(s)), `${what}: script-src allows any host`);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"], `${what}: no other site may frame the app`);
  assert.deepEqual(policy["object-src"], ["'none'"], `${what}: no plugins`);
  const nonce = nonceIn(header);
  assert.ok(nonce, `${what}: script-src should name a nonce`);
  return nonce;
}

/** GET `path` as `cookie` without following redirects. */
const get = (path, cookie) =>
  fetch(new URL(path, BASE), { redirect: "manual", headers: cookie ? { cookie: [cookie].flat().join("; ") } : {} });

/**
 * Load `path` through support.mjs's withPage() (its options are this
 * function's) and hand it to `fn` with `violations`: every
 * Content-Security-Policy violation the browser saw, on that page or any it
 * moved on to, as the page's own securitypolicyviolation events and as the
 * errors the browser logs (which are there even with JavaScript off).
 */
function watch(path, { prepare, ...options } = {}, fn) {
  const violations = [];
  const listen = async (page) => {
    await page.exposeFunction("__cspViolation", (v) => violations.push(v));
    await page.evaluateOnNewDocument(() => {
      document.addEventListener(
        "securitypolicyviolation",
        (e) =>
          window.__cspViolation({
            page: location.href,
            directive: e.effectiveDirective,
            blocked: e.blockedURI,
            source: `${e.sourceFile}:${e.lineNumber}`,
            sample: e.sample,
          }),
        true
      );
    });
    page.on("console", (msg) => {
      if (/content.security.policy/i.test(msg.text())) violations.push({ page: page.url(), console: msg.text() });
    });
    await prepare?.(page);
  };
  return withPage(browser, path, { ...options, prepare: listen }, ({ page, res }) => fn({ page, res, violations }));
}

/**
 * Do `act` (a click, a form submission) and wait for the navigation it
 * starts. A navigation the policy blocks never finishes, so the wait gives
 * up after NAVIGATION_TIMEOUT_MS and the caller's assertions say why.
 */
async function navigatingBy(page, act) {
  const navigation = page.waitForNavigation({ waitUntil: "networkidle0", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null);
  await act();
  await navigation;
}

/** Click the `selector` element whose text is `label`. */
async function clickLabelled(page, selector, label) {
  for (const el of await page.$$(selector)) {
    if ((await el.evaluate((e) => e.textContent.trim())) === label) return el.click();
  }
  throw new Error(`no "${label}" ${selector} on ${page.url()}`);
}

/** One line per violation, for a failure message. */
const describe = (violations) => violations.map((v) => JSON.stringify(v)).join("\n");

function assertNoViolations(violations, what) {
  assert.deepEqual(violations, [], `${what} tripped the Content-Security-Policy:\n${describe(violations)}`);
}

/**
 * Assert the page's own scripts ran: Next.js's runtime set window.next, which
 * it only does once its scripts, each carrying the nonce, were let through.
 */
async function assertScriptsRan(page, what) {
  assert.ok(
    await page.evaluate(() => typeof window.next?.version === "string"),
    `${what}: the app's own scripts did not run (no window.next), so the policy blocked them`
  );
}

/** Load `path`, scroll it, and assert its scripts ran without a violation. */
async function assertCleanVisit(path, options = {}) {
  await watch(path, options, async ({ page, res, violations }) => {
    assert.equal(res?.status(), 200, `${path} should load, got ${res?.status()}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForNetworkIdle({ idleTime: 300 });
    await assertScriptsRan(page, path);
    assertNoViolations(violations, path);
  });
}

// ─── The header ──────────────────────────────────────────────────────────

test("every page is sent with an enforcing policy and a nonce made for that response alone", async () => {
  const passed = await ageCheckCookie("1970-01-01");
  const pages = [...PUBLIC_PAGES, ...(await pagesUnder("/legal")), ...(exists("blog") ? await pagesUnder("/blog") : [])];
  for (const path of pages) {
    const [first, second] = [await get(path, passed), await get(path, passed)];
    assert.equal(first.status, 200, `${path} should load, got ${first.status}`);
    const nonce = assertEnforcing(first, path);
    assert.notEqual(assertEnforcing(second, `${path}, again`), nonce, `${path} should get a fresh nonce on every request`);

    // Every script Next.js wrote into the page carries that response's nonce.
    const html = await first.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.ok(scripts.length > 0, `${path} should have scripts`);
    for (const tag of scripts) {
      if (/type="application\/ld\+json"/.test(tag)) continue; // data, never run
      assert.ok(tag.includes(`nonce="${nonce}"`), `${path}: a script without this response's nonce: ${tag}`);
    }
  }

  await asSignedInUser(async (cookie) => {
    const res = await get("/dashboard", cookie);
    assert.equal(res.status, 200);
    assertEnforcing(res, "/dashboard");
  });
  // Pages that never render still carry it: a redirect and a page not found.
  const redirect = await get("/dashboard");
  assert.ok(redirect.status >= 300 && redirect.status < 400, `/dashboard signed out should redirect, got ${redirect.status}`);
  assertEnforcing(redirect, "the redirect from /dashboard");
  const missing = await get(`/no-such-page-${crypto.randomUUID()}`);
  assert.equal(missing.status, 404);
  assertEnforcing(missing, "a 404 page");
});

// ─── Normal use trips nothing ────────────────────────────────────────────

test("the public, legal and blog pages run their scripts without a violation", async () => {
  for (const path of PUBLIC_PAGES) await assertCleanVisit(path);
  await assertCleanVisit("/sign-up", { cookie: await ageCheckCookie("1970-01-01") });
  for (const path of await pagesUnder("/legal")) await assertCleanVisit(path);
  if (exists("blog")) for (const path of await pagesUnder("/blog")) await assertCleanVisit(path);
});

test("passing the age screen, a plain form post, trips nothing", async () => {
  // With JavaScript off, so the browser itself submits the form and follows
  // the redirect, which is what form-action is checked against.
  await watch("/sign-up", { javaScript: false }, async ({ page, violations }) => {
    await page.$eval('input[type="date"]', (el) => (el.value = "1970-01-01"));
    await navigatingBy(page, () => page.$eval('form:has(input[type="date"])', (f) => f.submit()));
    assertNoViolations(violations, "answering the age screen");
    assert.equal(new URL(page.url()).pathname, "/sign-up", "the age screen should send the visitor back to /sign-up");
  });
});

test("each sign-in button hands the visitor to its identity provider without a violation", async () => {
  const idpHost = `localhost:${FAKE_OIDC_PORT}`;
  const labels = await watch("/sign-in", {}, ({ page }) =>
    page.$$eval("button", (bs) => bs.map((b) => b.textContent.trim()).filter((t) => t.startsWith("Continue with")))
  );
  assert.ok(labels.length > 0, "/sign-in should offer at least one sign-in provider");
  for (const label of labels) {
    await watch("/sign-in", { allow: [idpHost] }, async ({ page, violations }) => {
      await assertScriptsRan(page, "/sign-in");
      await navigatingBy(page, () => clickLabelled(page, "button", label));
      assertNoViolations(violations, `"${label}"`);
      assert.equal(new URL(page.url()).host, idpHost, `"${label}" should have gone to the identity provider, ended on ${page.url()}`);
    });
  }
});

test("a sign-in started from a plain form reaches its identity provider without a violation", async () => {
  // The buttons above navigate from script, which form-action doesn't
  // govern. A sign-in form posted by the browser itself (a server action
  // calling signIn(), or any page before it hydrates) is redirected to the
  // provider, and Chrome checks that redirect against form-action.
  const idpHost = `localhost:${FAKE_OIDC_PORT}`;
  const providers = Object.values(await (await get("/api/auth/providers")).json()).filter((p) => p.type !== "email");
  assert.ok(providers.length > 0, "the app should offer at least one OAuth provider");
  for (const { id } of providers) {
    await watch("/api/auth/csrf", { allow: [idpHost], javaScript: false }, async ({ page, violations }) => {
      const { csrfToken } = JSON.parse(await page.$eval("body", (b) => b.textContent));
      await page.goto(new URL("/sign-in", BASE).href, { waitUntil: "networkidle0" });
      await navigatingBy(page, () =>
        page.evaluate(
          (action, csrfToken) => {
            const form = Object.assign(document.createElement("form"), { method: "post", action });
            form.append(Object.assign(document.createElement("input"), { type: "hidden", name: "csrfToken", value: csrfToken }));
            document.body.append(form);
            form.submit();
          },
          `/api/auth/signin/${id}`,
          csrfToken
        )
      );
      assertNoViolations(violations, `a form sign-in through ${id}`);
      assert.equal(new URL(page.url()).host, idpHost, `a form sign-in through ${id} should have reached the identity provider, ended on ${page.url()}`);
    });
  }
});

test("the dashboard and a job's report run without a violation, and report text never runs", async () => {
  const db = await connectDb();
  try {
    await asSignedInUser(async (cookie) => {
      await assertCleanVisit("/dashboard", { cookie });

      // A finished report whose text is the kind of thing a model might be
      // talked into writing. React escapes it; the policy is the backstop.
      const payload = `<script>window.__fromReport = 1</script><img src="x" onerror="window.__fromReport = 1">`;
      const job = await insertJob(db, cookie, payload);
      await watch(`/dashboard/jobs/${job}`, { cookie }, async ({ page, res, violations }) => {
        assert.equal(res?.status(), 200, `the report page should load, got ${res?.status()}`);
        await assertScriptsRan(page, "the report page");
        assert.ok((await page.content()).includes("window.__fromReport"), "the report text should be on the page, as text");
        assert.equal(await page.evaluate(() => window.__fromReport), undefined, "text from a report ran as a script");
        assertNoViolations(violations, "the report page");
      });
    });
  } finally {
    await db.end();
  }
});

/**
 * Insert a completed url-report job for the user signed in as `cookie`, with
 * `text` as its question, title, summary and insight. Returns its id. The user's id is read back
 * from the session the dashboard sees, not guessed.
 */
async function insertJob(db, cookie, text) {
  const session = await (await get("/api/auth/session", cookie)).json();
  const userId = session?.user?.id;
  assert.ok(userId, "the minted session should name a user");
  const { rows } = await db.query(
    `insert into jobs (user_id, status, type, input, output, progress, completed_at)
     values ($1, 'completed', 'url-report', $2, $3, 100, now()) returning id`,
    [
      userId,
      JSON.stringify({ url: "https://example.com/", question: text }),
      JSON.stringify({
        status: "completed",
        duration_seconds: 1.5,
        results: {
          "Results Generation": {
            status: "success",
            url: "https://example.com/",
            title: text,
            summary: text,
            insights: [text],
            sources: ["https://example.com/"],
            ai_enhanced: true,
          },
        },
      }),
    ]
  );
  return rows[0].id;
}

// cc:begin stripe
test("checkout hands the visitor to Stripe without a violation, with or without JavaScript", async () => {
  const stripeHost = `localhost:${FAKE_STRIPE_PORT}`;
  const upgrade = '#upgrade form:has(input[name="planId"]) button[type="submit"]';
  for (const javaScript of [true, false]) {
    const what = `checkout with JavaScript ${javaScript ? "on" : "off"}`;
    await asSignedInUser((cookie) =>
      watch("/dashboard/settings", { cookie, allow: [stripeHost], javaScript }, async ({ page, violations }) => {
        if (javaScript) await assertScriptsRan(page, "/dashboard/settings");
        assert.ok(await page.$(upgrade), "the settings page should offer an upgrade");
        // With JavaScript off the browser posts the form itself and follows
        // the redirect to Stripe, which form-action is checked against.
        await navigatingBy(page, () => page.click(upgrade));
        assertNoViolations(violations, what);
        assert.equal(new URL(page.url()).host, stripeHost, `${what} should have gone to Stripe, ended on ${page.url()}`);
      })
    );
  }
});
// cc:end stripe

// cc:begin analytics
test("accepting analytics loads and sends it without a violation", async () => {
  const since = posthog.captures().length;
  await watch(
    "/",
    {
      // posthog-js drops events from what it takes for a bot; see
      // support.mjs's openAsVisitor().
      prepare: async (page) => {
        await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
          Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true });
        });
      },
    },
    async ({ page, violations }) => {
      await assertScriptsRan(page, "/");
      // With session replay on, say yes to recording too, so the recorder
      // loads under the policy as well.
      if (sessionReplay()) await page.click("#consent-recording");
      await clickLabelled(page, "#consent-banner button", "Accept");
      const deadline = Date.now() + 20000;
      while (posthog.captures().length <= since && Date.now() < deadline) await sleep(200);
      assert.ok(posthog.captures().length > since, "analytics should have been sent after Accept");
      for (const [x, y] of [[40, 40], [200, 160], [120, 260]]) await page.mouse.move(x, y, { steps: 4 });
      await page.goto(new URL("/legal", BASE).href, { waitUntil: "networkidle0" });
      await sleep(1000);
      assertNoViolations(violations, "accepting analytics");
    }
  );
});
// cc:end analytics

// ─── An injected script does not run ─────────────────────────────────────

// How long the browser gets to deliver a violation report. report-uri sends
// it at once.
const REPORT_TIMEOUT_MS = 10_000;

/** The `[csp-violation]` lines the app has logged so far. */
const reportsLogged = () =>
  fs
    .readFileSync(process.env.SERVER_LOG, "utf8")
    .split("\n")
    .filter((l) => l.includes("[csp-violation]"));

test("a script injected into a page without the nonce does not run, and is reported", async () => {
  assert.ok(process.env.SERVER_LOG, "SERVER_LOG should name the app's log (scripts/check_compliance.sh sets it)");
  const logged = reportsLogged().length;
  const marker = `injected-${crypto.randomUUID()}`;

  // Serve "/" exactly as the app sent it, headers and all, with an attacker's
  // markup added: an inline script, an inline event handler, and, to prove
  // the injection itself works, a script that carries the real nonce.
  const intercept = async (req) => {
    if (req.resourceType() !== "document" || new URL(req.url()).pathname !== "/") return false;
    const res = await fetch(req.url(), { redirect: "manual" });
    const nonce = nonceIn(res.headers.get("content-security-policy"));
    const html = (await res.text()).replace(
      "<head>",
      `<head><script>window.__injected = "${marker}"</script>` +
        `<script nonce="${nonce}">window.__withNonce = true</script>`
    ).replace("<body>", `<body><img src="/${marker}.png" alt="" onerror="window.__handler = true">`);
    const headers = Object.fromEntries([...res.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k)));
    await req.respond({ status: res.status, headers, body: html });
    return true;
  };

  await watch("/", { intercept }, async ({ page, violations }) => {
    await assertScriptsRan(page, "/");
    assert.equal(await page.evaluate(() => window.__withNonce), true, "the script carrying the nonce should run (the injection itself failed)");
    assert.equal(await page.evaluate(() => window.__injected), undefined, "an injected inline <script> without the nonce ran");
    assert.equal(await page.evaluate(() => window.__handler), undefined, "an injected inline event handler ran");
    assert.ok(
      violations.some((v) => v.directive?.startsWith("script-src") && v.blocked === "inline"),
      `the browser should have reported blocking the inline script:\n${describe(violations)}`
    );

    // The browser reports it to app/api/csp-report/route.ts, which logs it.
    const deadline = Date.now() + REPORT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const fresh = reportsLogged().slice(logged);
      if (fresh.some((l) => /"effectiveDirective":"script-src/.test(l) && l.includes(`"documentURL":"${BASE.origin}/"`))) return;
      await sleep(500);
    }
    assert.fail(
      `the violation was never reported to /api/csp-report within ${REPORT_TIMEOUT_MS / 1000}s ` +
        `(logged meanwhile: ${reportsLogged().slice(logged).join(" | ") || "nothing"})`
    );
  });
});

// ─── The report endpoint ─────────────────────────────────────────────────

test("the report endpoint takes both report formats, logs no query strings, and refuses junk", async () => {
  const post = (body, type) =>
    fetch(new URL("/api/csp-report", BASE), { method: "POST", headers: { "content-type": type }, body });
  const secret = `token-${crypto.randomUUID()}`;
  const before = reportsLogged().length;

  const legacy = await post(
    JSON.stringify({
      "csp-report": {
        "document-uri": `${BASE.origin}/unsubscribe?token=${secret}`,
        "blocked-uri": "https://evil.example/x.js?" + secret,
        "effective-directive": "script-src-elem",
      },
    }),
    "application/csp-report"
  );
  assert.equal(legacy.status, 204);
  const modern = await post(
    JSON.stringify([
      { type: "csp-violation", body: { documentURL: `${BASE.origin}/#${secret}`, blockedURL: "inline", effectiveDirective: "script-src-elem", disposition: "enforce" } },
      { type: "deprecation", body: { id: "x" } },
    ]),
    "application/reports+json"
  );
  assert.equal(modern.status, 204);

  let lines = [];
  for (let i = 0; i < 20 && lines.length < 2; i++) {
    lines = reportsLogged().slice(before);
    await sleep(100);
  }
  assert.equal(lines.length, 2, `both reports, and only the violation of the batch, should be logged:\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.includes(`"documentURL":"${BASE.origin}/unsubscribe"`)), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes('"blockedURL":"https://evil.example/x.js"')), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes(secret)), "a URL's query string or fragment was logged");

  assert.equal((await post("x".repeat(70 * 1024), "application/csp-report")).status, 413, "an oversized report should be refused");
  assert.equal((await post("{}", "text/plain")).status, 415, "a body that isn't a report should be refused");
  assert.equal((await post("not json", "application/csp-report")).status, 400);
});
