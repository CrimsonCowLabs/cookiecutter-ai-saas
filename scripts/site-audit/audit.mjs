#!/usr/bin/env node
/*
Audit the public landing page in site/ for mobile, accessibility and
performance problems (issue #39), in a real browser.

scripts/check_site.py reads the served HTML, which is enough to prove what the
page says. It cannot prove how the page lays out at 320px, whether a focus
ring shows, or whether a border is visible against its background: those only
exist once a browser has applied the CSS. This script is that second half. It
is a dev-time tool like scripts/generate_og_image.py, not a page dependency:
nothing in site/ references it, and the page still ships as committed files
with no build step.

It serves the site directory itself on a free local port, drives a headless
Chrome through playwright-core, and checks, across widths 320/375/768/1280
(the two phone widths emulate a touch phone at 2x), both colour schemes, and
the page's script on and off:

   1. no horizontal page overflow (plus a 300..1440px sweep in 8px steps);
   2. the navbar's items never overlap each other (plus the same sweep);
   3. no visible text runs past the viewport or is cut off by an
      overflow:hidden/clip container;
   4. every interactive element is at least 44px on its smallest side,
      except links inline in running prose, which are listed as info;
   5. body text is at least 16px and no visible text is under 12px;
   6. the script-inserted theme toggle does not move the navbar or <main>;
   7. every real Tab stop shows a focus indicator, is on screen and not
      covered, and Tab eventually leaves the page (no trap);
   8. axe-core finds no WCAG 2.2 A/AA violations, also with the theme
      overridden against the system scheme via localStorage;
   9. form-control and unchecked-checkbox borders reach 3:1 against what is
      behind them;
  10. the no-JS contact outcomes (#contact-sent, #contact-error, shown by CSS
      :target) render on screen and inside the viewport at 320 and 1280;
  11. the page requests no images at all (og-image.png is for link previews
      and must only be named by meta tags).

Every off-origin request (the Cloudflare beacon) is blocked, so results do
not depend on the network. "Script off" is emulated by serving the page with
`Content-Security-Policy: script-src 'none'`, not by turning JavaScript off
in the browser: the page's own scripts never run, but the audit can still run
axe-core in it (axe needs a working event loop, which a JS-disabled page does
not have). That is only equivalent while the page has no <noscript> and no
`@media (scripting)`, so the audit refuses to run if either appears.

Usage (from the repo root):

    npm ci --prefix scripts/site-audit
    CHROME_PATH=/path/to/chrome node scripts/site-audit/audit.mjs [site-dir]

The optional argument audits a copy of site/ instead, the same way
check_site.py takes one. Without CHROME_PATH, playwright-core looks for its
own downloaded Chromium (`npx playwright-core install chromium` from
scripts/site-audit fetches one).

Exit status: 0 when every check passes, 1 when any fails, 2 when the audit
itself could not run.
*/

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const AXE_SOURCE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

// ---- What is checked, and where ---------------------------------------------

// The four widths the issue names. Below 768 is a phone: touch, mobile
// viewport handling and a 2x screen, which is what changes text autosizing
// and hover/pointer media queries. The heights are just plausible screens.
const WIDTHS = [320, 375, 768, 1280];
const PHONE_BELOW = 768;
const SCHEMES = ['dark', 'light'];
const viewportHeight = (width) => (width < PHONE_BELOW ? 740 : width === 768 ? 1024 : 800);

// The layout sweep: every 8px between these, script on, one scheme. The
// earlier one-off audit found navbar collisions only between the four fixed
// widths (768-932px, 480-488px), which is why a sweep exists at all.
const SWEEP_FROM = 300;
const SWEEP_TO = 1440;
const SWEEP_STEP = 8;
const SWEEP_SCHEME = 'dark';

// WCAG 2.5.5 (AAA) size, which the page adopted as its floor (see .btn in
// styles.css). WCAG 2.5.8's 24px is the AA minimum; this is stricter on
// purpose.
const MIN_TARGET = 44;
const MIN_BODY_TEXT = 16;
const MIN_TEXT = 12;
// WCAG 1.4.11: user-interface components need 3:1 against adjacent colours.
const MIN_NON_TEXT_CONTRAST = 3;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// The page's own names (see docs/public-site.md, "Look and themes" and
// "Consulting, contact and measurement").
const THEME_KEY = 'cookiecutter-ai-saas-theme';
const TARGET_STATES = ['contact-sent', 'contact-error'];
const TARGET_STATE_WIDTHS = [320, 1280];

// Sub-pixel layout makes exact comparisons flaky; half a pixel is invisible.
const TOLERANCE = 0.5;
const MAX_TAB_STOPS = 300;
// Sent by the browser on "script off" runs; the built-in server answers it
// with a CSP that blocks every page script (see the module comment).
const NO_SCRIPTS_HEADER = 'x-site-audit-no-scripts';

const CHECKS = {
  overflow: '1. No horizontal page overflow',
  navbar: '2. Navbar items do not overlap',
  text: '3. No text past the viewport or clipped by its container',
  target: `4. Interactive targets at least ${MIN_TARGET}px`,
  font: `5. Body text at least ${MIN_BODY_TEXT}px, no text under ${MIN_TEXT}px`,
  shift: '6. Script-inserted controls do not shift layout',
  focus: '7. Keyboard focus visible, on screen, no trap',
  axe: '8. axe-core WCAG 2.2 A/AA',
  border: `9. Form control borders at least ${MIN_NON_TEXT_CONTRAST}:1`,
  targetState: '10. :target contact messages render',
  images: '11. No image requests',
};

// ---- Results -----------------------------------------------------------------

const failures = [];
const inlineLinks = new Map();
const blockedRequests = new Set();
const imageRequests = new Map();

// One problem, in one configuration. `where` is a label such as "320/dark/js"
// or "sweep/776"; the report groups identical (check, selector, detail)
// triples and lists every `where` and distinct measured `value` under one line.
function fail(check, where, selector, detail, value = '') {
  failures.push({ check, where, selector, detail, value: String(value) });
}

const px = (n) => `${Math.round(n * 10) / 10}px`;
const label = (width, scheme, js, extra = '') => `${width}/${scheme}${extra}/${js ? 'js' : 'no-js'}`;

// ---- Static server -----------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Serves `dir` on 127.0.0.1 at a port the OS picks. Just enough of a static
// server for one page: no directory listings, nothing outside `dir`.
function serve(dir) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.resolve(dir, '.' + pathname);
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (file !== dir && !file.startsWith(dir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
      if (req.headers[NO_SCRIPTS_HEADER]) headers['content-security-policy'] = "script-src 'none'";
      res.writeHead(200, headers).end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// ---- In-page measurement ------------------------------------------------------

// Installed into every page as window.__audit. Runs inside the browser, so it
// can only use what is defined in here, plus the size `limits` passed in.
// Everything it returns is plain data with elements already described as
// selector-like strings.
function installAuditLib(limits) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let seq = 0;
  const ids = new WeakMap();

  // "tag#id", or "parent > tag.class.list" when there is no id.
  function own(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    return cls.length ? `${tag}.${cls.join('.')}` : tag;
  }
  function describe(el) {
    if (el.id) return own(el);
    const parent = el.parentElement;
    return parent && parent !== document.body ? `${own(parent)} > ${own(el)}` : own(el);
  }
  const textOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  // Not rendered, or rendered as the .sr-only / honeypot pattern: a box of at
  // most 1px that clips its content. Screen readers still get those; eyes and
  // fingers do not, so no visual check applies to them.
  function isHidden(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const rect = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      const clips = s.clipPath !== 'none' || /hidden|clip/.test(s.overflowX + s.overflowY);
      if ((rect.width <= 1 || rect.height <= 1) && clips) return true;
    }
    return false;
  }

  // Colours: let the canvas parse whatever the computed style says (rgb,
  // color(srgb ...), oklab from color-mix, alpha) into sRGB bytes, then
  // composite by hand.
  function parse(str) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = str;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function over(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  }
  function luminance(c) {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function ratio(a, b) {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  // The flat colour behind `el`: every background-color from <html> down,
  // composited over the white canvas. Gradients and images are ignored,
  // which suits this page (its only background image is the faint ambient
  // glow).
  function backgroundBehind(el) {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.unshift(e);
    return chain.reduce((acc, e) => over(parse(getComputedStyle(e).backgroundColor), acc), [255, 255, 255, 1]);
  }

  // The box the glyphs of a text node actually occupy, which can be wider
  // than the element holding them when the text overflows it.
  function textBox(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  }
  // An element's box, widened to cover any of its text that spills out.
  function inkBox(el) {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      if (!n.textContent.trim() || isHidden(n.parentElement)) continue;
      const t = textBox(n);
      if (!t) continue;
      box.left = Math.min(box.left, t.left);
      box.right = Math.max(box.right, t.right);
      box.top = Math.min(box.top, t.top);
      box.bottom = Math.max(box.bottom, t.bottom);
    }
    return box;
  }

  function* visibleTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest('script, style, noscript, template')) continue;
      if (parseFloat(getComputedStyle(el).fontSize) === 0 || isHidden(el)) continue;
      yield n;
    }
  }

  // 1. The innermost elements that stick out sideways, unless something
  // between them and <body> clips or scrolls them. Fixed elements never
  // make the page scroll, so they are skipped.
  function overflowOffenders(vw) {
    const sticksOut = (el) => {
      const r = el.getBoundingClientRect();
      return r.right > vw + 0.5 || r.left < -0.5;
    };
    const contained = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') return true;
      }
      return false;
    };
    const out = [...document.body.querySelectorAll('*')].filter(
      (el) => getComputedStyle(el).position !== 'fixed' && sticksOut(el) && !isHidden(el) && !contained(el),
    );
    return out
      .filter((el) => !out.some((o) => o !== el && el.contains(o)))
      .map((el) => ({ sel: describe(el), right: el.getBoundingClientRect().right }));
  }

  // 2. Pairs of navbar items whose boxes (text spill included) intersect.
  // Items are the bar's direct children plus every visible link, button,
  // icon and the brand name inside them. Only the most specific colliding
  // pair is kept: "brand name over the Stack link", not also "brand over
  // nav".
  function navbarOverlaps() {
    const inner = document.querySelector('.navbar-inner');
    if (!inner) return [];
    const items = [...new Set([...inner.children, ...inner.querySelectorAll('a, button, svg, .brand-name')])].filter(
      (el) => !isHidden(el),
    );
    const boxes = items.map(inkBox);
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const [a, b] = [items[i], items[j]];
        if (a.contains(b) || b.contains(a)) continue;
        const ox = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
        const oy = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
        if (ox > 1 && oy > 1) pairs.push({ a, b, ox });
      }
    }
    const within = (x, y) => y.contains(x);
    return pairs
      .filter(
        (p) =>
          !pairs.some(
            (q) =>
              q !== p &&
              ((within(q.a, p.a) && within(q.b, p.b)) || (within(q.a, p.b) && within(q.b, p.a))),
          ),
      )
      .map((p) => ({ a: describe(p.a), b: describe(p.b), ox: p.ox }));
  }

  // 3. Text cut off by an overflow:hidden/clip ancestor, or past the
  // viewport. Scrolling ancestors (the install command's <pre>) are fine:
  // the text is reachable. Their visible window is what the rest of the
  // walk then measures against.
  function textProblems(vw, root = document.body) {
    const found = new Map();
    for (const node of visibleTextNodes(root)) {
      let box = textBox(node);
      if (!box) continue;
      const el = node.parentElement;
      let problem = null;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const r = a.getBoundingClientRect();
        const win = {
          left: r.left + a.clientLeft,
          right: r.left + a.clientLeft + a.clientWidth,
          top: r.top + a.clientTop,
          bottom: r.top + a.clientTop + a.clientHeight,
        };
        const cuts = (axis) => /hidden|clip/.test(axis === 'x' ? s.overflowX : s.overflowY);
        const excessX = Math.max(win.left - box.left, box.right - win.right);
        const excessY = Math.max(win.top - box.top, box.bottom - win.bottom);
        if (cuts('x') && excessX > 1) problem = { kind: `cut off by ${describe(a)}`, by: excessX };
        else if (cuts('y') && excessY > 1) problem = { kind: `cut off by ${describe(a)}`, by: excessY };
        if (problem) break;
        box = {
          left: Math.max(box.left, win.left),
          right: Math.min(box.right, win.right),
          top: Math.max(box.top, win.top),
          bottom: Math.min(box.bottom, win.bottom),
        };
        if (box.left >= box.right || box.top >= box.bottom) break;
      }
      if (!problem && box.left < box.right) {
        const by = Math.max(-box.left, box.right - vw);
        if (by > 1) problem = { kind: 'runs past the viewport', by };
      }
      if (!problem) continue;
      const key = describe(el) + '|' + problem.kind;
      if (!found.has(key) || found.get(key).by < problem.by) found.set(key, { sel: describe(el), ...problem });
    }
    return [...found.values()];
  }

  // 5. The body's own size, long paragraphs of running prose in <main>
  // (120+ characters), and anything visible below the
  // floor. font-size: 0 is how the phone theme toggle hides its labels, so
  // that text is not visible text.
  function fontProblems() {
    const small = new Map();
    for (const node of visibleTextNodes(document.body)) {
      const el = node.parentElement;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < limits.minText) small.set(describe(el), size);
    }
    const prose = new Map();
    for (const p of document.querySelectorAll('main p')) {
      const size = parseFloat(getComputedStyle(p).fontSize);
      if (p.textContent.trim().length >= 120 && !isHidden(p) && size < limits.minBodyText) prose.set(describe(p), size);
    }
    return {
      body: parseFloat(getComputedStyle(document.body).fontSize),
      small: [...small].map(([sel, size]) => ({ sel, size })),
      prose: [...prose].map(([sel, size]) => ({ sel, size })),
    };
  }

  // 4. A link inline in running prose: displayed inline, and the nearest
  // block around it has text of its own. WCAG 2.5.8 exempts these, since
  // the sentence sets their size.
  function inlineInProse(a) {
    if (getComputedStyle(a).display !== 'inline') return false;
    let block = a.parentElement;
    while (block && /^(inline|contents)$/.test(getComputedStyle(block).display)) block = block.parentElement;
    return !!block && block.textContent.replace(a.textContent, '').trim().length > 0;
  }
  function targetProblems() {
    const fails = [];
    const inline = [];
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(selector)) {
      if (isHidden(el)) continue;
      // A checkbox wrapped in its label is hit anywhere on the label row.
      const target = el.matches('input[type="checkbox"], input[type="radio"]') ? el.closest('label') || el : el;
      const r = target.getBoundingClientRect();
      if (Math.min(r.width, r.height) >= limits.minTarget - 0.01) continue;
      if (el.tagName === 'A' && inlineInProse(el)) {
        inline.push({ sel: describe(el), text: textOf(el), h: r.height });
        continue;
      }
      fails.push({ sel: describe(target), w: r.width, h: r.height });
    }
    return { fails, inline };
  }

  // 9. Each field's top border, composited over what is behind the field.
  function borderContrast() {
    const out = [];
    const fields = new Set(document.querySelectorAll('.input, select, textarea, input.checkbox:not(:checked)'));
    for (const el of fields) {
      if (isHidden(el)) continue;
      const s = getComputedStyle(el);
      const behind = backgroundBehind(el.parentElement);
      const border = over(parse(s.borderTopColor), behind);
      const width = parseFloat(s.borderTopWidth);
      out.push({ sel: describe(el), width, ratio: width > 0 ? ratio(border, behind) : 1, border: hex(border), behind: hex(behind) });
    }
    return out;
  }

  window.__audit = {
    // Everything checked on a freshly loaded page, before anything scrolls.
    snapshot() {
      const de = document.documentElement;
      const vw = de.clientWidth;
      const nav = document.querySelector('.navbar');
      const main = document.querySelector('main');
      return {
        metrics: {
          navHeight: nav ? nav.getBoundingClientRect().height : null,
          mainTop: main ? main.getBoundingClientRect().top + scrollY : null,
        },
        overflow: { scrollWidth: de.scrollWidth, clientWidth: vw, offenders: de.scrollWidth > vw ? overflowOffenders(vw) : [] },
        navbar: navbarOverlaps(),
        text: textProblems(vw),
        fonts: fontProblems(),
        targets: targetProblems(),
        borders: borderContrast(),
      };
    },

    // The cheap subset the width sweep needs.
    sweep() {
      const de = document.documentElement;
      const vw = de.clientWidth;
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: vw,
        offenders: de.scrollWidth > vw ? overflowOffenders(vw) : [],
        navbar: navbarOverlaps(),
      };
    },

    borders: borderContrast,

    // 7. The element Tab just landed on, or null once focus has left the
    // document. A focus indicator is a non-zero outline or a box-shadow.
    // "Covered" means the topmost element at the middle of its on-screen
    // part is something unrelated, such as the sticky navbar.
    focused() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      if (!ids.has(el)) ids.set(el, ++seq);
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const [vw, vh] = [document.documentElement.clientWidth, innerHeight];
      const indicator = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      const vis = { left: Math.max(r.left, 0), right: Math.min(r.right, vw), top: Math.max(r.top, 0), bottom: Math.min(r.bottom, vh) };
      const onScreen = vis.right - vis.left > 1 && vis.bottom - vis.top > 1;
      let coveredBy = null;
      if (onScreen) {
        const top = document.elementFromPoint((vis.left + vis.right) / 2, (vis.top + vis.bottom) / 2);
        const related =
          !top || top === el || el.contains(top) || top.contains(el) || [...(el.labels || [])].some((l) => l.contains(top));
        if (!related) coveredBy = describe(top);
      }
      return {
        id: ids.get(el),
        sel: describe(el),
        text: textOf(el),
        indicator,
        style: `outline ${s.outlineStyle} ${s.outlineWidth}, box-shadow ${s.boxShadow}`,
        hidden: isHidden(el),
        onScreen,
        coveredBy,
      };
    },

    // 10. Where a :target message ended up after navigating to it.
    targetState(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const nav = document.querySelector('.navbar');
      const vw = document.documentElement.clientWidth;
      return {
        display: getComputedStyle(el).display,
        width: r.width,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        vw,
        vh: innerHeight,
        navBottom: nav ? nav.getBoundingClientRect().bottom : 0,
        text: textProblems(vw, el),
      };
    },
  };
}

// ---- Browser plumbing --------------------------------------------------------

async function launch() {
  const executablePath = process.env.CHROME_PATH || undefined;
  try {
    return await chromium.launch({ executablePath, headless: true });
  } catch (err) {
    const how = executablePath
      ? `CHROME_PATH=${executablePath} did not start.`
      : 'CHROME_PATH is not set and playwright-core has no Chromium of its own.';
    console.error(`site-audit: could not start Chrome. ${how}`);
    console.error('Set CHROME_PATH to a Chrome/Chromium binary, or run');
    console.error('`npx playwright-core install chromium` in scripts/site-audit.');
    console.error(String(err.message || err).split('\n')[0]);
    process.exit(2);
  }
}

// A fresh context per configuration, so no localStorage, focus or scroll
// state leaks between runs. Off-origin requests are aborted; every request
// is recorded for check 11.
async function openPage(browser, base, { width, height, scheme, js, theme = null, hash = '', where }) {
  const phone = width < PHONE_BELOW;
  const context = await browser.newContext({
    viewport: { width, height: height ?? viewportHeight(width) },
    isMobile: phone,
    hasTouch: phone,
    deviceScaleFactor: phone ? 2 : 1,
    colorScheme: scheme,
    extraHTTPHeaders: js ? {} : { [NO_SCRIPTS_HEADER]: '1' },
  });
  context.on('request', (req) => {
    const url = req.url();
    const isImage = req.resourceType() === 'image' || /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|#|$)/i.test(url);
    if (isImage && !imageRequests.has(url)) imageRequests.set(url, where);
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    blockedRequests.add(url);
    return route.abort();
  });
  if (theme) {
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch (err) {
          // No storage, no override; the data-theme assertion below says so.
        }
      },
      [THEME_KEY, theme],
    );
  }
  const page = await context.newPage();
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(installAuditLib, { minTarget: MIN_TARGET, minText: MIN_TEXT, minBodyText: MIN_BODY_TEXT });
  return { context, page };
}

async function runAxe(page, where) {
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async (tags) => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.join(' '), data: (n.any[0] || n.all[0] || n.none[0] || {}).data || null })),
    }));
  }, AXE_TAGS);
  for (const v of violations) {
    for (const n of v.nodes) {
      if (v.id === 'color-contrast' && n.data && n.data.contrastRatio) {
        const d = n.data;
        fail('axe', where, n.target, `color-contrast: below ${d.expectedContrastRatio}`, `${d.contrastRatio}:1 (${d.fgColor} on ${d.bgColor})`);
      } else {
        fail('axe', where, n.target, `${v.id}: ${v.help}`);
      }
    }
  }
}

// Real Tab presses from the top of the page until focus leaves the document
// or comes back round to the first stop. Revisiting any other stop first, or
// never leaving, is a trap.
async function tabWalk(page, where) {
  let first = null;
  const seen = new Set();
  for (let i = 0; i < MAX_TAB_STOPS; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => window.__audit.focused());
    if (!f || f.id === first) return;
    if (seen.has(f.id)) break;
    if (first === null) first = f.id;
    seen.add(f.id);
    const sel = f.text ? `${f.sel} "${f.text}"` : f.sel;
    if (f.hidden) fail('focus', where, sel, 'Tab stop is not visible');
    else if (!f.onScreen) fail('focus', where, sel, 'Tab stop is off screen when focused');
    else if (f.coveredBy) fail('focus', where, sel, 'focused element is covered', f.coveredBy);
    if (!f.hidden && !f.indicator) fail('focus', where, sel, 'no visible focus indicator', f.style);
  }
  fail('focus', where, '(document)', 'Tab never leaves the page (focus trap)', `${seen.size} stops`);
}

// ---- The checks ----------------------------------------------------------------

// Checks 1-5, 7, 8 and 9 in one configuration of the matrix; returns the
// navbar/main metrics check 6 compares across script on and off.
async function auditConfig(browser, base, width, scheme, js) {
  const where = label(width, scheme, js);
  const { context, page } = await openPage(browser, base, { width, scheme, js, where });
  const snap = await page.evaluate(() => window.__audit.snapshot());

  const { scrollWidth, clientWidth, offenders } = snap.overflow;
  if (scrollWidth > clientWidth) {
    fail('overflow', where, 'html', 'page scrolls sideways', `scrollWidth ${scrollWidth} > ${clientWidth}`);
    for (const o of offenders) fail('overflow', where, o.sel, 'sticks out past the right edge', `right ${px(o.right)} > ${clientWidth}`);
  }
  for (const o of snap.navbar) fail('navbar', where, `${o.a}  x  ${o.b}`, 'overlap', `${px(o.ox)} wide`);
  for (const t of snap.text) fail('text', where, t.sel, t.kind, `by ${px(t.by)}`);
  for (const t of snap.targets.fails) fail('target', where, t.sel, `smaller than ${MIN_TARGET}px`, `${px(t.w)} x ${px(t.h)}`);
  for (const l of snap.targets.inline) inlineLinks.set(`${l.sel} "${l.text}"`, l.h);
  if (snap.fonts.body < MIN_BODY_TEXT) fail('font', where, 'body', `body text under ${MIN_BODY_TEXT}px`, px(snap.fonts.body));
  for (const p of snap.fonts.prose) fail('font', where, p.sel, `running prose under ${MIN_BODY_TEXT}px`, px(p.size));
  for (const s of snap.fonts.small) fail('font', where, s.sel, `text under ${MIN_TEXT}px`, px(s.size));
  recordBorders(where, snap.borders);

  await runAxe(page, where);
  await tabWalk(page, where);
  await context.close();
  return snap.metrics;
}

function recordBorders(where, borders) {
  for (const b of borders) {
    if (b.ratio < MIN_NON_TEXT_CONTRAST) {
      fail('border', where, b.sel, `border under ${MIN_NON_TEXT_CONTRAST}:1 against its background`, `${b.ratio.toFixed(2)}:1 (${b.border} on ${b.behind})`);
    }
  }
}

// 6. The toggle is inserted by the script; with the script off the navbar
// must already have the height it will have with it on.
function compareShift(metrics) {
  for (const width of WIDTHS) {
    for (const scheme of SCHEMES) {
      const on = metrics.get(label(width, scheme, true));
      const off = metrics.get(label(width, scheme, false));
      const where = `${width}/${scheme}`;
      if (Math.abs(on.navHeight - off.navHeight) > TOLERANCE) {
        fail('shift', where, 'header.navbar', 'height changes when the script runs', `${px(off.navHeight)} -> ${px(on.navHeight)}`);
      }
      if (Math.abs(on.mainTop - off.mainTop) > TOLERANCE) {
        fail('shift', where, 'main#top', 'top moves when the script runs', `${px(off.mainTop)} -> ${px(on.mainTop)}`);
      }
    }
  }
}

// 8 + 9 again with the theme forced against the system scheme, which is the
// [data-theme] copy of each palette rather than the media-query one.
async function auditOverrides(browser, base) {
  for (const width of WIDTHS) {
    for (const scheme of SCHEMES) {
      const theme = scheme === 'dark' ? 'light' : 'dark';
      const where = label(width, scheme, true, `>${theme}`);
      const { context, page } = await openPage(browser, base, { width, scheme, js: true, theme, where });
      const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (applied !== theme) fail('axe', where, 'html', `localStorage ${THEME_KEY}=${theme} did not set data-theme`, String(applied));
      recordBorders(where, await page.evaluate(() => window.__audit.borders()));
      await runAxe(page, where);
      await context.close();
    }
  }
}

// 10. Navigate straight to each no-JS outcome, as the server's 303 does.
async function auditTargetStates(browser, base) {
  for (const width of TARGET_STATE_WIDTHS) {
    for (const scheme of SCHEMES) {
      for (const js of [true, false]) {
        for (const id of TARGET_STATES) {
          const where = label(width, scheme, js) + `#${id}`;
          const { context, page } = await openPage(browser, base, { width, scheme, js, hash: `#${id}`, where });
          const s = await page.evaluate((i) => window.__audit.targetState(i), id);
          const sel = `#${id}`;
          if (!s) fail('targetState', where, sel, 'element missing');
          else if (s.display === 'none' || s.height === 0) fail('targetState', where, sel, 'not shown when targeted', `display ${s.display}`);
          else {
            if (s.left < -TOLERANCE || s.right > s.vw + TOLERANCE) fail('targetState', where, sel, 'extends past the viewport', `${px(s.left)}..${px(s.right)} of ${s.vw}`);
            if (s.top < s.navBottom - 1) fail('targetState', where, sel, 'lands under the sticky navbar', `top ${px(s.top)} < ${px(s.navBottom)}`);
            if (s.top >= s.vh) fail('targetState', where, sel, 'lands below the fold', `top ${px(s.top)}`);
            for (const t of s.text) fail('targetState', where, t.sel, `text ${t.kind}`, `by ${px(t.by)}`);
          }
          await context.close();
        }
      }
    }
  }
}

// 1 + 2 between the fixed widths. One phone context for widths below 768 and
// one desktop context above, each resized in place.
async function sweep(browser, base) {
  const widths = [];
  for (let w = SWEEP_FROM; w <= SWEEP_TO; w += SWEEP_STEP) widths.push(w);
  for (const phone of [true, false]) {
    const mine = widths.filter((w) => w < PHONE_BELOW === phone);
    if (!mine.length) continue;
    const { context, page } = await openPage(browser, base, { width: mine[0], scheme: SWEEP_SCHEME, js: true, where: `sweep/${mine[0]}` });
    for (const width of mine) {
      await page.setViewportSize({ width, height: viewportHeight(width) });
      const s = await page.evaluate(() => window.__audit.sweep());
      const where = `sweep/${width}`;
      if (s.scrollWidth > s.clientWidth) {
        fail('overflow', where, 'html', 'page scrolls sideways', `scrollWidth ${s.scrollWidth} > ${s.clientWidth}`);
        for (const o of s.offenders) fail('overflow', where, o.sel, 'sticks out past the right edge', `right ${px(o.right)} > ${s.clientWidth}`);
      }
      for (const o of s.navbar) fail('navbar', where, `${o.a}  x  ${o.b}`, 'overlap', `${px(o.ox)} wide`);
    }
    await context.close();
  }
}

// ---- Report --------------------------------------------------------------------

// "320/dark/js", "320/light/no-js", ... -> "320 [dark/js, light/no-js]".
// Widths that failed in the same configurations share one bracket, and the
// four plain scheme/script combinations read as "all" ("all+overrides" with
// the two theme-override runs as well). Sweep widths collapse into runs:
// "sweep 768-928px". Labels are "width/scheme[>theme]/js|no-js[#hash]".
function formatWhere(wheres) {
  const plain = SCHEMES.flatMap((s) => ['js', 'no-js'].map((j) => `${s}/${j}`));
  const overrides = SCHEMES.map((s) => `${s}>${s === 'dark' ? 'light' : 'dark'}/js`);
  const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));
  const sweeps = [];
  const byWidth = new Map();
  const other = [];
  for (const w of wheres) {
    let m;
    if ((m = /^sweep\/(\d+)$/.exec(w))) sweeps.push(Number(m[1]));
    else if ((m = /^(\d+)\/(.+)$/.exec(w))) {
      if (!byWidth.has(m[1])) byWidth.set(m[1], []);
      byWidth.get(m[1]).push(m[2]);
    } else other.push(w);
  }
  const bySignature = new Map();
  for (const [width, rests] of byWidth) {
    let sig = rests.join(', ');
    if (sameSet(rests, plain)) sig = 'all';
    else if (sameSet(rests, plain.concat(overrides))) sig = 'all+overrides';
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(width);
  }
  const parts = [...bySignature].map(([sig, widths]) => `${widths.join(', ')} [${sig}]`);
  if (sweeps.length) {
    sweeps.sort((a, b) => a - b);
    const runs = [];
    for (const w of sweeps) {
      const last = runs[runs.length - 1];
      if (last && w - last[1] === SWEEP_STEP) last[1] = w;
      else runs.push([w, w]);
    }
    parts.push('sweep ' + runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') + 'px');
  }
  return parts.concat(other).join('; ');
}

// Groups the raw failures twice: first every configuration of one
// (check, selector, detail), then the selectors that failed identically
// (same detail, same measurements, same configurations), so the six cards
// sharing one low-contrast colour are one entry, not six. A "problem" in the
// totals is one element (selector) failing one check.
function report(elapsed) {
  const byCheck = new Map(Object.keys(CHECKS).map((k) => [k, new Map()]));
  for (const f of failures) {
    const groups = byCheck.get(f.check);
    const key = `${f.selector}\u0000${f.detail}`;
    if (!groups.has(key)) groups.set(key, { selector: f.selector, detail: f.detail, wheres: [], values: new Set() });
    const g = groups.get(key);
    if (!g.wheres.includes(f.where)) g.wheres.push(f.where);
    if (f.value) g.values.add(f.value);
  }

  let problems = 0;
  for (const [check, groups] of byCheck) {
    if (!groups.size) continue;
    problems += groups.size;
    const merged = new Map();
    for (const g of groups.values()) {
      const values = [...g.values];
      const at = formatWhere(g.wheres);
      const key = [g.detail, values.join('\u0001'), at].join('\u0000');
      if (!merged.has(key)) merged.set(key, { detail: g.detail, values, at, selectors: [] });
      merged.get(key).selectors.push(g.selector);
    }
    console.log(`\nFAIL ${CHECKS[check]} (${groups.size})`);
    for (const m of merged.values()) {
      console.log(`  - ${m.detail}`);
      for (const sel of m.selectors) console.log(`      ${sel}`);
      if (m.values.length) {
        const more = m.values.length > 4 ? ` (+${m.values.length - 4} more)` : '';
        console.log(`      measured: ${m.values.slice(0, 4).join('; ')}${more}`);
      }
      console.log(`      at: ${m.at}`);
    }
  }

  if (inlineLinks.size) {
    console.log(`\ninfo: ${inlineLinks.size} links inline in running prose are exempt from the ${MIN_TARGET}px target size:`);
    for (const [link, h] of inlineLinks) console.log(`  - ${link} (${px(h)} tall)`);
  }
  if (blockedRequests.size) {
    console.log('\ninfo: off-origin requests blocked during the audit:');
    for (const url of blockedRequests) console.log(`  - ${url}`);
  }

  console.log('\nSummary');
  for (const [check, groups] of byCheck) console.log(`  ${groups.size ? 'FAIL' : 'ok  '}  ${CHECKS[check]}${groups.size ? ` (${groups.size})` : ''}`);
  console.log(`\n${problems ? `${problems} problems` : 'All checks passed'} (${(elapsed / 1000).toFixed(1)}s).`);
  return problems;
}

// ---- Main ----------------------------------------------------------------------

async function main() {
  const siteDir = path.resolve(process.argv[2] || path.join(ROOT, 'site'));
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
    console.error(`site-audit: no index.html in ${siteDir}`);
    process.exit(2);
  }
  // The script-off emulation is only faithful without these; see the top.
  const sources = fs.readdirSync(siteDir).filter((f) => /\.(html|css)$/.test(f));
  for (const f of sources) {
    const text = fs.readFileSync(path.join(siteDir, f), 'utf8');
    if (/<noscript\b/i.test(text) || /@media[^{]*\bscripting\b/i.test(text)) {
      console.error(`site-audit: ${f} uses <noscript> or @media (scripting), which the CSP-based`);
      console.error('"script off" runs cannot reproduce. Switch them to javaScriptEnabled: false first.');
      process.exit(2);
    }
  }

  const started = Date.now();
  const { server, base } = await serve(siteDir);
  const browser = await launch();
  console.log(`site-audit: ${path.relative(process.cwd(), siteDir) || '.'} at ${base}, ${browser.version()}`);

  try {
    const metrics = new Map();
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        for (const js of [true, false]) {
          metrics.set(label(width, scheme, js), await auditConfig(browser, base, width, scheme, js));
        }
      }
    }
    console.log(`  matrix: ${metrics.size} configurations`);
    compareShift(metrics);
    await auditOverrides(browser, base);
    console.log(`  theme overrides: ${WIDTHS.length * SCHEMES.length} configurations`);
    await auditTargetStates(browser, base);
    console.log(`  :target states: ${TARGET_STATE_WIDTHS.length * SCHEMES.length * 2 * TARGET_STATES.length} loads`);
    await sweep(browser, base);
    console.log(`  sweep: ${SWEEP_FROM}-${SWEEP_TO}px every ${SWEEP_STEP}px`);
    for (const [url, where] of imageRequests) fail('images', where, url.startsWith(base) ? url.slice(base.length - 1) : url, 'image requested');
  } finally {
    await browser.close();
    server.close();
  }

  process.exit(report(Date.now() - started) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
