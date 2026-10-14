// Session replay never records anyone without their own consent, and never
// what they type (California Invasion of Privacy Act) — run against a REALLY
// RUNNING app (scripts/check_compliance.sh boots one) in a real headless
// Chrome, because "nothing was recorded" is a fact about what left the
// browser. See docs/compliance.md, "Session recording".
//
// The stand-in PostHog (./fake-posthog.mjs) plays a project with replay
// turned on in its settings, so whether anything is recorded is down to the
// app alone. Every recording it receives is unpacked, and the tests look in
// it for marker text they put on the page: text that shows up proves the
// page was recorded, and text that must not (what was typed, what was on a
// page that is never recorded) failing to show up proves it wasn't.
//
// What runs depends on config.ts's analytics.sessionReplay, off by default:
// off, nothing is ever recorded, whatever the visitor or a cookie says; on,
// only after the visitor's separate consent to recording. CI runs this file
// both ways.
//
// Only ships in projects generated with analytics=posthog.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// FAKE_POSTHOG_PORT; plus CHROME_PATH (see ./support.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  config,
  exists,
  launchBrowser,
  openAsVisitor,
  shown,
  clickButton,
  consentCookie,
  sessionReplay,
  asSignedInUser,
} from "./support.mjs";
import { startFakePostHog } from "./fake-posthog.mjs";

// Long enough for anything recorded to have been uploaded: the recorder
// buffers for about two seconds before it sends.
const QUIET_MS = 6000;
// How long a page that should be recorded gets to show up in a recording.
const SEND_TIMEOUT_MS = 20000;

const BANNER = "#consent-banner";
const RECORDING_CHOICE = "#consent-recording";
const CONTROLS = "#analytics-choices";

const REPLAY = sessionReplay();
const onlyWhenOff = { skip: REPLAY && "analytics.sessionReplay is on in config.ts" };
const onlyWhenOn = { skip: !REPLAY && "analytics.sessionReplay is off in config.ts" };

// Both purposes answered "yes" on an earlier visit.
const RECORDING_CONSENT = consentCookie({ analytics: "granted", recording: "granted" });

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

const open = (path, options, fn) => openAsVisitor(browser, path, options, fn);

let markers = 0;
/** Text found nowhere else, for a test to put on a page and look for. */
const marker = (what) => `${what}-${process.pid}-${++markers}`;

/**
 * Move the mouse and scroll, as a visitor does. posthog-js holds a recording
 * back until the visitor has interacted with the page, so without this a
 * page that IS being recorded would look as if it weren't.
 */
async function actLikeAVisitor(page) {
  for (const [x, y] of [[40, 40], [200, 160], [120, 260]]) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.wheel({ deltaY: 200 });
}

/**
 * Append a paragraph saying `text` to the page, as the app might render, and
 * then interact with the page (see actLikeAVisitor).
 */
async function addText(page, text) {
  await page.evaluate((text) => {
    const p = document.createElement("p");
    p.textContent = text;
    (document.querySelector("main") ?? document.body).append(p);
  }, text);
  await actLikeAVisitor(page);
}

/** Wait until a recording PostHog received since request `since` says `text`. */
async function recorded(text, since) {
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (posthog.recordings(since).some((r) => r.includes(text))) return;
    await sleep(250);
  }
  assert.fail(`"${text}" was on a recorded page but no recording of it reached PostHog within ${SEND_TIMEOUT_MS / 1000}s`);
}

/** Wait until analytics runs: PostHog receives more than `count` event captures. */
async function captured(count) {
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (posthog.captures().length > count) return;
    await sleep(200);
  }
  assert.fail(`no analytics event reached PostHog within ${SEND_TIMEOUT_MS / 1000}s`);
}

/** Assert that, over QUIET_MS, no recording PostHog received since `since` says `text`. */
async function neverRecorded(text, since, why) {
  await sleep(QUIET_MS);
  const leaks = posthog.recordings(since).filter((r) => r.includes(text));
  assert.equal(leaks.length, 0, `${why}, but a recording containing "${text}" reached PostHog`);
}

/** Assert that, over QUIET_MS, PostHog received no recording at all since `since`. */
async function nothingRecorded(since, why) {
  await sleep(QUIET_MS);
  assert.equal(posthog.recordings(since).length, 0, `${why}, but PostHog received a recording`);
}

/**
 * Wait until the page is being recorded: something added to it shows up in a
 * recording.
 */
async function recordingRuns(page, since) {
  const text = marker("recording-runs");
  await addText(page, text);
  await recorded(text, since);
}

test("with session replay off in config, accepting analytics records nothing", onlyWhenOff, async () => {
  const since = await posthog.settled();
  await open("/", {}, async ({ page }) => {
    assert.equal(await shown(page, RECORDING_CHOICE), false, "recording should not be offered while config turns it off");
    const captures = posthog.captures().length;
    await clickButton(page, BANNER, "Accept");
    await captured(captures);

    await addText(page, marker("not-recorded"));
    await nothingRecorded(since, "analytics consent alone must never start a recording");
  });
  await open("/legal/analytics", {}, async ({ page }) => {
    const labels = await page.$$eval(`${CONTROLS} button`, (els) => els.map((el) => el.textContent.trim()));
    assert.ok(!labels.some((l) => /record/i.test(l)), `/legal/analytics should offer no recording control, but has ${labels}`);
  });
});

test("with session replay off in config, even a cookie saying yes to recording records nothing", onlyWhenOff, async () => {
  const since = await posthog.settled();
  await open("/", { cookie: RECORDING_CONSENT }, async ({ page }) => {
    await addText(page, marker("not-recorded"));
    await nothingRecorded(since, "config turns recording off, which no consent cookie can override");
  });
});

test("recording is offered as its own choice, not ticked, and accepting analytics alone records nothing", onlyWhenOn, async () => {
  const since = await posthog.settled();
  await open("/", {}, async ({ page }) => {
    assert.ok(await shown(page, RECORDING_CHOICE), "the banner should offer recording as a separate choice");
    const choice = await page.$eval(RECORDING_CHOICE, (el) => ({
      type: el.type,
      checked: el.checked,
      label: el.labels?.[0]?.textContent.trim() ?? "",
    }));
    assert.equal(choice.type, "checkbox");
    assert.equal(choice.checked, false, "recording must not be pre-selected: consent is something the visitor does");
    assert.match(choice.label, /record/i, "the recording choice should be labelled as such");

    const captures = posthog.captures().length;
    await clickButton(page, BANNER, "Accept");
    await captured(captures);
    await addText(page, marker("not-recorded"));
    await nothingRecorded(since, "accepting analytics without choosing recording must not start one");
  });
});

test("recording starts only after its own consent, and never captures what is typed", onlyWhenOn, async () => {
  const since = await posthog.settled();
  await open("/", {}, async ({ page }) => {
    await page.click(RECORDING_CHOICE);
    await clickButton(page, BANNER, "Accept");
    assert.equal(await shown(page, BANNER), false, 'the banner should close after "Accept"');
    await recordingRuns(page, since);

    // What a visitor types into any input, and text the app marks as
    // sensitive, never leave the browser.
    const typed = marker("typed-secret");
    const sensitive = marker("marked-sensitive");
    await page.evaluate((sensitive) => {
      const form = document.createElement("form");
      for (const type of ["text", "email", "password", "search"]) {
        const input = document.createElement("input");
        input.type = type;
        input.name = `probe-${type}`;
        input.setAttribute("aria-label", `probe ${type}`);
        form.append(input);
      }
      const textarea = document.createElement("textarea");
      textarea.name = "probe-textarea";
      textarea.setAttribute("aria-label", "probe textarea");
      form.append(textarea);
      const p = document.createElement("p");
      p.textContent = sensitive;
      p.setAttribute("data-mask", "");
      form.append(p);
      (document.querySelector("main") ?? document.body).append(form);
    }, sensitive);
    for (const field of await page.$$("form input[name^=probe], form textarea[name^=probe]")) {
      await field.type(`${typed}@example.com`);
    }
    // Once this is in a recording, so is everything before it.
    await recordingRuns(page, since);

    const leaks = posthog.recordings(since).filter((r) => r.includes(typed) || r.includes(sensitive));
    assert.equal(leaks.length, 0, "typed input or text marked data-mask reached PostHog in a recording");
  });
});

test("recording never runs on the sign-in, sign-up, billing or settings pages", onlyWhenOn, async () => {
  const pages = ["/sign-in", "/sign-up"];
  if (exists("(auth)/magic-link")) pages.push("/magic-link");
  for (const path of pages) {
    const since = await posthog.settled();
    await open(path, { cookie: RECORDING_CONSENT }, async ({ page }) => {
      await addText(page, marker("never-recorded"));
      await nothingRecorded(since, `${path} is never recorded`);
    });
  }

  // Billing and the account settings share one page.
  await asSignedInUser(async (session) => {
    const since = await posthog.settled();
    await open("/dashboard/settings", { cookie: [RECORDING_CONSENT, session] }, async ({ page }) => {
      assert.equal(new URL(page.url()).pathname, "/dashboard/settings", "the signed-in user should reach settings");
      await addText(page, marker("never-recorded"));
      await nothingRecorded(since, "/dashboard/settings is never recorded");
    });
  });
});

test("recording stops when the visitor moves to a page that is never recorded", onlyWhenOn, async () => {
  const since = await posthog.settled();
  await open("/", { cookie: RECORDING_CONSENT }, async ({ page }) => {
    await recordingRuns(page, since);

    // A client-side navigation, the way Next.js follows a link: the page
    // swaps its content without reloading, which a recorder would see.
    await Promise.all([
      page.waitForFunction(() => location.pathname === "/sign-in"),
      page.click('footer a[href="/sign-in"]'),
    ]);
    await page.waitForSelector("main h1");
    const heading = await page.$eval("main h1", (el) => el.textContent.trim());
    const after = marker("after-navigation");
    await addText(page, after);
    await neverRecorded(after, since, "recording should stop on /sign-in");
    await neverRecorded(heading, since, "the sign-in page's content should never be recorded");
  });
});

test("a Global Privacy Control signal stops recording too", onlyWhenOn, async () => {
  const since = await posthog.settled();
  await open("/", { cookie: RECORDING_CONSENT, gpc: true }, async ({ page }) => {
    await addText(page, marker("not-recorded"));
    await nothingRecorded(since, "a browser sending GPC has refused, whatever it agreed to before");
  });
});

test("withdrawing recording consent stops recording at once", onlyWhenOn, async () => {
  const since = await posthog.settled();
  await open("/legal/analytics", { cookie: RECORDING_CONSENT }, async ({ page }) => {
    await recordingRuns(page, since);

    await clickButton(page, CONTROLS, "Turn recording off");
    const after = marker("after-withdrawal");
    await addText(page, after);
    await neverRecorded(after, since, "nothing should be recorded after recording consent is withdrawn");

    // It can be turned back on from the same place.
    await clickButton(page, CONTROLS, "Turn recording on");
    await recordingRuns(page, since);

    // Turning analytics off turns recording off with it.
    await clickButton(page, CONTROLS, "Turn analytics off");
    const afterAnalytics = marker("after-analytics-off");
    await addText(page, afterAnalytics);
    await neverRecorded(afterAnalytics, since, "nothing should be recorded once analytics is off");
  });
});
