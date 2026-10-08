// The legal hub at /legal and its subpages are there, reachable without
// signing in, and linked from the landing page's footer — run against a REALLY
// RUNNING app (scripts/check_compliance.sh boots one). Several of these pages
// are the notice a law requires the app to show, so "the route exists in the
// source tree" is not enough: a visitor has to be able to load it.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  config,
  legalConfig,
  links,
  minimumAge as configuredMinimumAge,
  unescapeHtml,
} from "./support.mjs";

async function get(path) {
  const res = await fetch(new URL(path, config.baseUrl), { redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

test("the footer links to the legal hub", async () => {
  const { status, html } = await get("/");
  assert.equal(status, 200);
  const footer = html.slice(html.lastIndexOf("<footer"));
  assert.ok(links(footer).includes("/legal"), "the footer should link to /legal");
});

test("the legal hub loads and sits next to the Privacy Policy and Terms", async () => {
  const { status, html } = await get("/legal");
  assert.equal(status, 200, `/legal should load unauthenticated, got ${status}`);
  const hrefs = links(html);
  assert.ok(hrefs.includes("/privacy-policy"), "/legal should link to the Privacy Policy");
  assert.ok(hrefs.includes("/tos"), "/legal should link to the Terms of Service");
  assert.ok(
    hrefs.includes("/legal/fonts"),
    "/legal should link to the fonts and third-party requests subpage"
  );
});

test("every subpage the hub links to loads, explains itself and disclaims legal advice", async () => {
  const hub = await get("/legal");
  const subpages = [...new Set(links(hub.html).filter((h) => h.startsWith("/legal/")))];
  assert.ok(subpages.length > 0, "/legal should link to at least one subpage");

  for (const path of subpages) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${path} should load unauthenticated, got ${status}`);
    for (const heading of ["The risk", "How this app handles it"]) {
      assert.ok(html.includes(heading), `${path} should have a "${heading}" section`);
    }
    assert.match(html, /not legal advice/i, `${path} should say it is not legal advice`);
  }
});

test("the accessibility statement gives the configured contact address and review date", async () => {
  const { status, html } = await get("/legal/accessibility");
  assert.equal(status, 200, `/legal/accessibility should load unauthenticated, got ${status}`);
  assert.ok(links((await get("/legal")).html).includes("/legal/accessibility"), "/legal should link to it");
  const page = unescapeHtml(html);
  for (const key of ["contactEmail", "reviewDate"]) {
    const value = legalConfig("accessibility", key);
    assert.ok(page.includes(value), `/legal/accessibility should show legal.accessibility.${key} ("${value}")`);
  }
  assert.ok(
    page.includes(`href="mailto:${legalConfig("accessibility", "contactEmail")}"`),
    "the contact address should be a mailto: link"
  );
  assert.match(html, /WCAG 2\.2/, "the statement should name its target standard");
});

test("the copyright page names the configured DMCA agent and is linked from the Terms of Service", async () => {
  const { status, html } = await get("/legal/copyright");
  assert.equal(status, 200, `/legal/copyright should load unauthenticated, got ${status}`);
  assert.ok(links((await get("/legal")).html).includes("/legal/copyright"), "/legal should link to it");
  const page = unescapeHtml(html);
  for (const key of ["name", "postalAddress", "phone", "email"]) {
    const value = legalConfig("dmcaAgent", key);
    // As the element's whole text, not just somewhere (an href included).
    assert.ok(page.includes(`>${value}<`), `/legal/copyright should show legal.dmcaAgent.${key} ("${value}")`);
  }
  const email = legalConfig("dmcaAgent", "email").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    page,
    new RegExp(`<a [^>]*href="mailto:${email}"[^>]*>${email}</a>`),
    "the agent's email address should be a mailto: link showing the address"
  );
  assert.match(html, /what a takedown notice must contain/i, "it should list what a takedown notice must contain");
  assert.match(html, /under penalty of perjury/i, "the notice list should include the sworn statement");
  assert.match(html, /counter-notice/i, "it should explain counter-notices");
  assert.match(html, /repeat infringer/i, "it should state the repeat-infringer policy");

  const terms = await get("/tos");
  assert.ok(links(terms.html).includes("/legal/copyright"), "the Terms of Service should link to it");
  assert.match(terms.html, /repeat infringer/i, "the Terms of Service should state the repeat-infringer policy");
});

test("the children's privacy notice gives the configured minimum age and a way for parents to reach the operator", async () => {
  const minimumAge = configuredMinimumAge();

  const { status, html } = await get("/legal/children");
  assert.equal(status, 200, `/legal/children should load unauthenticated, got ${status}`);
  assert.ok(links((await get("/legal")).html).includes("/legal/children"), "/legal should link to it");
  assert.match(html, new RegExp(`at least (<!-- -->)?${minimumAge}\\b`), `it should say accounts need to be at least ${minimumAge}`);
  assert.match(html, /href="mailto:[^"]+@[^"]+"/, "it should give parents an email address to write to");

  const policy = await get("/privacy-policy");
  assert.ok(links(policy.html).includes("/legal/children"), "the Privacy Policy should link to it");
  assert.match(policy.html, new RegExp(`at least (<!-- -->)?${minimumAge}\\b`), "the Privacy Policy should state the minimum age too");
});

test("the analytics page is linked from the hub and the Privacy Policy, and says what is tracked", async () => {
  const { status, html } = await get("/legal/analytics");
  assert.equal(status, 200, `/legal/analytics should load unauthenticated, got ${status}`);
  assert.ok(links((await get("/legal")).html).includes("/legal/analytics"), "/legal should link to it");
  // cc:begin analytics
  assert.match(html, /PostHog/, "it should name who receives the measurements");
  assert.match(html, /What is collected/, "it should say what is collected");
  assert.match(html, /How long it is kept/, "it should say how long it is kept");
  assert.match(html, /Global Privacy Control/, "it should say a GPC signal counts as a refusal");
  assert.ok(html.includes('id="analytics-choices"'), "it should have the controls to change or withdraw consent");
  // cc:end analytics
  // cc:begin no-analytics
  assert.match(html, /nothing is tracked/i, "it should say nothing is tracked");
  // cc:end no-analytics

  const policy = await get("/privacy-policy");
  assert.ok(links(policy.html).includes("/legal/analytics"), "the Privacy Policy should link to it");
});

// cc:begin resend
test("the email preferences page is linked from the hub and the Privacy Policy", async () => {
  const { status, html } = await get("/legal/email-preferences");
  assert.equal(status, 200, `/legal/email-preferences should load unauthenticated, got ${status}`);
  assert.ok(links((await get("/legal")).html).includes("/legal/email-preferences"), "/legal should link to it");
  assert.match(html, /unsubscribe/i, "it should explain how to unsubscribe");
  assert.match(html, /transactional/i, "it should say which emails are transactional");

  const policy = await get("/privacy-policy");
  assert.ok(links(policy.html).includes("/legal/email-preferences"), "the Privacy Policy should link to it");
});
// cc:end resend
