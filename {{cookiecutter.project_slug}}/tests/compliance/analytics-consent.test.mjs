// Analytics only runs with the visitor's consent — run against a REALLY
// RUNNING app (scripts/check_compliance.sh boots one) in a real headless
// Chrome, because "nothing is sent" is a fact about network traffic, and only
// a browser running the page's real scripts makes any. See
// docs/compliance.md, "Analytics and consent".
//
// The app talks to PostHog only through its own first-party proxy, /ingest
// (app/ingest/[...path]/route.ts), which check_compliance.sh points at a
// stand-in PostHog (./fake-posthog.mjs). So every analytics request shows up
// twice: in the browser, as a request to /ingest on the app's own origin, and
// at the stand-in, as the request the proxy forwarded. Both are checked.
//
// Only ships in projects generated with analytics=posthog.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// FAKE_POSTHOG_PORT; plus CHROME_PATH (see ./support.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { config, launchBrowser, withPage, consentCookie, consentTextVersion } from "./support.mjs";
import { startFakePostHog } from "./fake-posthog.mjs";

// The app has posthog-js send each event as it happens, and posthog-js would
// otherwise queue them for a few seconds; a page that would send anything has
// done so well within this.
const QUIET_MS = 5000;
// How long a page that should send something gets to do it.
const SEND_TIMEOUT_MS = 20000;

const BANNER = "#consent-banner";
const CONTROLS = "#analytics-choices";

let browser;
let posthog;
before(async () => {
  posthog = await startFakePostHog();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await posthog?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open `path` the way withPage() does, also recording every request the page
 * makes to /ingest (in `ingest`) and, with `gpc`, sending a Global Privacy
 * Control signal. fn gets withPage's arguments plus `ingest`.
 */
function open(path, { cookie, gpc = false } = {}, fn) {
  const ingest = [];
  const base = new URL(config.baseUrl);
  const prepare = async (page) => {
    // posthog-js drops events from browsers it takes for bots, and a headless
    // Chrome driven by puppeteer looks like one three ways (its user agent,
    // its client hints and navigator.webdriver); a visitor's browser doesn't.
    await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true });
    });
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.host === base.host && url.pathname.startsWith("/ingest")) ingest.push(url.pathname);
    });
    if (gpc) {
      // What a browser with GPC turned on (Firefox's setting, Brave, the
      // DuckDuckGo app, privacy extensions) exposes to every page.
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });
      });
    }
  };
  return withPage(browser, path, { cookie, prepare }, (args) => fn({ ...args, ingest }));
}

/** Whether the consent banner is on the page and visible. */
const bannerShown = (page) =>
  page.$eval(BANNER, (el) => el.checkVisibility()).catch(() => false);

/** Click the button labelled `label` inside `scope`, with the mouse. */
async function click(page, scope, label) {
  const buttons = await page.$$(`${scope} button`);
  for (const button of buttons) {
    if ((await button.evaluate((el) => el.textContent.trim())) === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`no "${label}" button in ${scope} on ${page.url()}`);
}

/** Wait until the stand-in has received more than `count` event captures. */
async function captureAfter(count) {
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (posthog.captures().length > count) return posthog.captures().slice(count);
    await sleep(200);
  }
  assert.fail(`no analytics event reached PostHog within ${SEND_TIMEOUT_MS / 1000}s`);
}

/** Every key PostHog keeps in this page's cookies and storage. */
const posthogStorage = (page) =>
  page.evaluate(() => {
    const ours = (key) => key.startsWith("ph_") || key.startsWith("__ph_");
    return [
      ...document.cookie.split("; ").map((c) => c.split("=")[0]).filter(ours).map((k) => `cookie ${k}`),
      ...Object.keys(localStorage).filter(ours).map((k) => `localStorage ${k}`),
      ...Object.keys(sessionStorage).filter(ours).map((k) => `sessionStorage ${k}`),
    ];
  });

/**
 * The number of requests PostHog has received, once it has received none for
 * a second: a page closed by the previous test can still send what it had
 * queued as it unloads.
 */
async function settled() {
  let count = -1;
  while (count !== posthog.requests.length) {
    count = posthog.requests.length;
    await sleep(1000);
  }
  return count;
}

/** Assert that, over QUIET_MS, nothing went to /ingest or reached PostHog. */
async function assertNothingSent(ingest, since, why) {
  await sleep(QUIET_MS);
  assert.deepEqual(ingest, [], `${why}, but the page called ${ingest.join(", ")}`);
  assert.deepEqual(
    posthog.requests.slice(since).map((r) => r.path),
    [],
    `${why}, but PostHog received requests`
  );
}

test("nothing is sent before the visitor has chosen, and the banner asks", async () => {
  const since = await settled();
  for (const path of ["/", "/legal/analytics"]) {
    await open(path, {}, async ({ page, ingest, offOrigin }) => {
      assert.ok(await bannerShown(page), `${path} should show the consent banner to a visitor who has not chosen`);
      await assertNothingSent(ingest, since, `${path} should send nothing before the visitor chooses`);
      assert.deepEqual(offOrigin, [], `${path} contacted another server`);
    });
  }
});

test('"Accept" and "Reject" are equally prominent', async () => {
  await open("/", {}, async ({ page }) => {
    const look = (label) =>
      page.$$eval(
        `${BANNER} button`,
        (buttons, label) => {
          const el = buttons.find((b) => b.textContent.trim() === label);
          if (!el) return null;
          const s = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            width: Math.round(box.width),
            height: Math.round(box.height),
            className: el.className,
            ...Object.fromEntries(
              ["color", "backgroundColor", "borderColor", "borderWidth", "fontSize", "fontWeight", "padding"].map((p) => [p, s[p]])
            ),
          };
        },
        label
      );
    const accept = await look("Accept");
    const reject = await look("Reject");
    assert.ok(accept && reject, 'the banner should have an "Accept" and a "Reject" button');
    assert.deepEqual(reject, accept, '"Reject" should look exactly like "Accept": same size, colours and type');
  });
});

test('after "Reject" nothing is sent, on that page or the next', async () => {
  const since = await settled();
  await open("/", {}, async ({ page, ingest }) => {
    await click(page, BANNER, "Reject");
    assert.equal(await bannerShown(page), false, 'the banner should close after "Reject"');
    await assertNothingSent(ingest, since, 'nothing should be sent after "Reject"');

    await page.goto(new URL("/legal", config.baseUrl).href, { waitUntil: "networkidle0" });
    assert.equal(await bannerShown(page), false, "a refusal should be remembered, not asked again");
    await assertNothingSent(ingest, since, 'nothing should be sent on the next page after "Reject"');
    assert.deepEqual(await posthogStorage(page), [], "PostHog should have stored nothing");
  });
});

test('after "Accept" analytics is sent, through the first-party proxy only', async () => {
  const since = posthog.captures().length;
  const requestsBefore = posthog.requests.length;
  await open("/", {}, async ({ page, ingest, offOrigin }) => {
    await click(page, BANNER, "Accept");
    assert.equal(await bannerShown(page), false, 'the banner should close after "Accept"');
    await captureAfter(since);
    assert.ok(ingest.length > 0, "the browser should have sent analytics to /ingest on the app's own domain");
    assert.deepEqual(offOrigin, [], "analytics should never make the browser contact another server");

    // The proxy forwards neither the visitor's cookies nor their IP address.
    for (const { path, headers } of posthog.requests.slice(requestsBefore)) {
      for (const header of ["cookie", "x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip"]) {
        assert.equal(headers[header], undefined, `the proxy forwarded ${header} to PostHog with ${path}`);
      }
      assert.ok(!path.startsWith("/static/"), `PostHog was asked for an extra script, ${path}`);
    }

    // The choice is remembered: the next page sends again without asking.
    const count = posthog.captures().length;
    await page.goto(new URL("/legal", config.baseUrl).href, { waitUntil: "networkidle0" });
    assert.equal(await bannerShown(page), false, "consent should be remembered, not asked again");
    await captureAfter(count);
  });
});

test("a Global Privacy Control signal counts as a refusal", async () => {
  const since = await settled();
  await open("/", { gpc: true }, async ({ page, ingest }) => {
    assert.equal(await bannerShown(page), false, "a browser sending GPC has already said no; it should not be asked");
    await assertNothingSent(ingest, since, "nothing should be sent when the browser sends GPC");
  });
  // Even over an earlier "Accept": the signal is the visitor's current choice.
  await open("/", { gpc: true, cookie: consentCookie("granted") }, async ({ ingest }) => {
    await assertNothingSent(ingest, since, "GPC should win over an earlier Accept");
  });
});

test("a new consent text version asks again, and sends nothing until answered", async () => {
  const since = await settled();
  const stale = consentCookie("granted", `${consentTextVersion()}-before`);
  await open("/", { cookie: stale }, async ({ page, ingest }) => {
    assert.ok(await bannerShown(page), "consent given to an earlier version of the text should not count");
    await assertNothingSent(ingest, since, "consent to an earlier version should send nothing");
  });
});

test("withdrawing consent stops analytics and clears what PostHog stored", async () => {
  await open("/legal/analytics", {}, async ({ page, ingest }) => {
    const since = posthog.captures().length;
    await click(page, BANNER, "Accept");
    await captureAfter(since);
    assert.notDeepEqual(await posthogStorage(page), [], "PostHog should have stored its ids once running");

    await click(page, CONTROLS, "Turn analytics off");
    await sleep(500);
    assert.deepEqual(await posthogStorage(page), [], "withdrawing should clear PostHog's cookies and storage");

    // Nothing more, on this page or the next.
    const requests = posthog.requests.length;
    ingest.length = 0;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.goto(new URL("/legal", config.baseUrl).href, { waitUntil: "networkidle0" });
    assert.equal(await bannerShown(page), false, "a withdrawal is a choice, and should not be asked again");
    await assertNothingSent(ingest, requests, "nothing should be sent after consent is withdrawn");
    assert.deepEqual(await posthogStorage(page), [], "PostHog should not store anything again");
  });
});

test('"Privacy choices" in the footer reopens the choice', async () => {
  await open("/", { cookie: consentCookie("denied") }, async ({ page }) => {
    assert.equal(await bannerShown(page), false, "a visitor who chose should not be asked again");
    await click(page, "footer", "Privacy choices");
    assert.ok(await bannerShown(page), '"Privacy choices" should show the banner again');
    const focusInBanner = await page.$eval(BANNER, (el) => el.contains(document.activeElement));
    assert.ok(focusInBanner, '"Privacy choices" should move focus to the banner');

    const since = posthog.captures().length;
    await click(page, BANNER, "Accept");
    await captureAfter(since);
  });
});
