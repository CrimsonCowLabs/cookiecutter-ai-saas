// The app's key pages meet WCAG 2.2 AA, as far as a machine can tell — run
// against a REALLY RUNNING app (scripts/check_compliance.sh boots one) in a
// real headless Chrome, because colour contrast, focus order and what a
// screen reader is told only exist once a browser has laid the page out. See
// docs/compliance.md, "Accessibility", for why this matters and for what an
// automated check cannot catch.
//
// Every page a visitor can sign in, sign up, read the legal pages or manage
// their account on is listed below. When you add a page, add it here too.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus CHROME_PATH (see ./support.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import axe from "axe-core";
import {
  config,
  launchBrowser,
  withPage,
  exists,
  pagesUnder,
  asSignedInUser,
  ageCheckCookie,
} from "./support.mjs";

// axe-core's rules for every WCAG 2.0, 2.1 and 2.2 success criterion at
// levels A and AA. (WCAG 2.2 added only one AA criterion axe can test, so its
// tag is short; the 2.0 and 2.1 tags carry most of the rules.)
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Every page is checked in DaisyUI's light and dark themes, which the app
// ships, and in the theme picked at generation time (the one it opens in,
// and the one that carries the brand colour), read off the page in before()
// below. A colour that reads fine on one background can fail on another.
let themes;

// /magic-link, /contact and /blog only exist for some answers at generation
// time (see exists()). Bare "/sign-up" is the age screen; its other states
// are in AGE_SCREEN_STATES below.
const PUBLIC_PAGES = [
  "/",
  "/sign-in",
  "/sign-up",
  "/sign-up?age_error=invalid",
  ...(exists("(auth)/magic-link") ? ["/magic-link"] : []),
  ...(exists("contact") ? ["/contact"] : []),
  "/privacy-policy",
  "/tos",
];
const SIGNED_IN_PAGES = [
  "/dashboard",
  ...(exists("dashboard/settings") ? ["/dashboard/settings"] : []),
];

// Past this many Tab presses a page is assumed to have no more stops worth
// checking; real pages here have far fewer.
const MAX_TAB_STOPS = 80;

let browser;
let otherPages;
before(async () => {
  browser = await launchBrowser();
  otherPages = [
    ...(await pagesUnder("/legal")),
    ...(exists("blog") ? await pagesUnder("/blog") : []),
  ];
  const home = await (await fetch(config.baseUrl)).text();
  const ownTheme = home.match(/<html[^>]*\sdata-theme="([^"]+)"/)?.[1];
  themes = [...new Set(["light", "dark", ...(ownTheme ? [ownTheme] : [])])];
});
after(async () => {
  await browser?.close();
});

// /sign-up once the age screen has been answered: the sign-up buttons and
// form for a visitor who passed, and the refusal for one who was turned away.
// Each is { label, dateOfBirth } — a date far from any minimum age.
const AGE_SCREEN_STATES = [
  { label: "/sign-up, age check passed", dateOfBirth: "1970-01-01" },
  { label: "/sign-up, turned away", dateOfBirth: new Date().toISOString().slice(0, 10) },
];

/**
 * Every listed page: fn(path, { cookie, label }), with the cookie to load it
 * with (if any) and the name to report it by.
 */
async function eachPage(fn) {
  for (const path of [...PUBLIC_PAGES, ...otherPages]) await fn(path, { label: path });
  for (const { label, dateOfBirth } of AGE_SCREEN_STATES) {
    await fn("/sign-up", { label, cookie: await ageCheckCookie(dateOfBirth) });
  }
  await asSignedInUser(async (cookie) => {
    for (const path of SIGNED_IN_PAGES) await fn(path, { label: path, cookie });
  });
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  // Let any colour transition settle before anything measures colours.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function describeViolations(path, theme, violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `      ${n.target.join(" ")}\n        ${n.failureSummary.replace(/\n/g, "\n        ")}`);
      return `  ${v.id} (${v.impact}): ${v.help}\n    ${v.helpUrl}\n${nodes.join("\n")}`;
    })
    .map((line) => `${path} in the ${theme} theme:\n${line}`)
    .join("\n");
}

test("every listed page passes axe's WCAG 2.2 AA rules in every theme", async (t) => {
  await eachPage(async (path, { label, ...options }) => {
    for (const theme of themes) {
      await t.test(`${label} (${theme})`, () =>
        withPage(browser, path, options, async ({ page, res }) => {
          assert.equal(res?.status(), 200, `${label} should load, got ${res?.status()}`);
          await setTheme(page, theme);
          await page.evaluate(axe.source);
          const { violations } = await page.evaluate(
            (tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
            WCAG_22_AA
          );
          assert.deepEqual(
            violations.map((v) => v.id),
            [],
            `axe found WCAG 2.2 AA violations:\n${describeViolations(label, theme, violations)}`
          );
        })
      );
    }
  });
});

test("the first Tab on every listed page reaches a working skip-to-content link", async (t) => {
  await eachPage(async (path, { label, ...options }) => {
    await t.test(label, () =>
      withPage(browser, path, options, async ({ page }) => {
        await page.keyboard.press("Tab");
        const link = await page.evaluate(() => {
          const el = document.activeElement;
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            tag: el.tagName,
            href: el.getAttribute("href") ?? "",
            text: el.textContent.trim(),
            // On screen, big enough to read, and not hidden the way
            // visually-hidden ("sr-only") text is.
            visible:
              box.width >= 16 &&
              box.height >= 16 &&
              box.top >= 0 &&
              box.left >= 0 &&
              box.bottom <= window.innerHeight &&
              box.right <= window.innerWidth &&
              style.opacity !== "0" &&
              style.visibility === "visible" &&
              style.clip === "auto" &&
              style.clipPath === "none",
          };
        });
        assert.ok(
          link.tag === "A" && link.href.startsWith("#") && /skip to (main )?content/i.test(link.text),
          `the first Tab on ${label} should focus a "Skip to content" link to an anchor on the page; ` +
            `it focused <${link.tag.toLowerCase()} href="${link.href}">${link.text.slice(0, 60)}`
        );
        assert.ok(link.visible, `the skip link on ${label} should be visible once it has focus`);

        await page.keyboard.press("Enter");
        const focused = await page.evaluate(() => ({
          id: document.activeElement?.id ?? "",
          tag: document.activeElement?.tagName ?? "",
        }));
        assert.equal(
          `#${focused.id}`,
          link.href,
          `following the skip link on ${label} should move focus to ${link.href}, ` +
            `but focus is on <${focused.tag.toLowerCase()} id="${focused.id}">`
        );
        assert.equal(focused.tag, "MAIN", `${link.href} on ${label} should be the page's <main>`);
      })
    );
  });
});

test("every element Tab reaches shows a clearly visible focus indicator in every theme", async (t) => {
  await eachPage(async (path, { label, ...options }) => {
    for (const theme of themes) {
      await t.test(`${label} (${theme})`, () =>
        withPage(browser, path, options, async ({ page }) => {
          await setTheme(page, theme);
          const problems = [];
          for (let i = 0; i < MAX_TAB_STOPS; i++) {
            await page.keyboard.press("Tab");
            const stop = await page.evaluate(focusIndicator);
            if (!stop) break;
            if (stop.problem) problems.push(`  ${stop.label}: ${stop.problem}`);
          }
          assert.deepEqual(
            problems,
            [],
            `on ${label} in the ${theme} theme, these elements have no clearly visible focus indicator ` +
              `(a solid outline at least 2px thick, with 3:1 contrast against what is behind it):\n` +
              problems.join("\n")
          );
        })
      );
    }
  });
});

/**
 * Runs in the page: describe document.activeElement's focus indicator, and
 * what (if anything) is wrong with it. Returns null once focus has left the
 * page's content (back to <body>, or out to the browser's own UI) or come
 * back round to an element it has already been on.
 *
 * The bar is WCAG 2.4.7 (focus visible) made concrete: a solid outline at
 * least 2px thick whose colour has 3:1 contrast (WCAG 1.4.11) against the
 * nearest opaque background behind the element. The browser's own default
 * ring ("outline-style: auto") does not count — it is thin, and its colour
 * is the browser's, not checked against this app's backgrounds.
 */
function focusIndicator() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  window.__focusSeen ??= new WeakSet();
  if (window.__focusSeen.has(el)) return null;
  window.__focusSeen.add(el);

  const rgba = (color) => {
    // Let the browser turn any CSS colour (DaisyUI's are oklch) into sRGB.
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const luminance = ({ r, g, b }) => {
    const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });

  const label =
    `<${el.tagName.toLowerCase()}` +
    (el.id ? ` id="${el.id}"` : "") +
    (el.getAttribute("href") ? ` href="${el.getAttribute("href")}"` : "") +
    `> "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
  const result = (problem) => ({ label, problem });

  const style = getComputedStyle(el);
  if (style.outlineStyle === "none" || style.outlineStyle === "auto") {
    return result(`outline is "${style.outlineStyle}"`);
  }
  if (parseFloat(style.outlineWidth) < 2) {
    return result(`outline is only ${style.outlineWidth} thick`);
  }

  // The outline is drawn around the element, so it sits on whatever is
  // behind the element: the nearest ancestor with an opaque background.
  let bg = { r: 255, g: 255, b: 255, a: 1 };
  for (let node = el.parentElement; node; node = node.parentElement) {
    const c = rgba(getComputedStyle(node).backgroundColor);
    if (c.a === 1) {
      bg = c;
      break;
    }
  }
  const fg = rgba(style.outlineColor);
  const [hi, lo] = [luminance(over(fg, bg)), luminance(bg)].sort((a, b) => b - a);
  const ratio = (hi + 0.05) / (lo + 0.05);
  if (ratio < 3) return result(`outline contrast is only ${ratio.toFixed(2)}:1`);
  return result(null);
}
