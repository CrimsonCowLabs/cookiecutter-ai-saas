// The legal hub at /legal and its subpages are there, reachable without
// signing in, and linked from the landing page's footer — run against a REALLY
// RUNNING app (scripts/check_compliance.sh boots one). Several of these pages
// are the notice a law requires the app to show, so "the route exists in the
// source tree" is not enough: a visitor has to be able to load it.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config, links, minimumAge as configuredMinimumAge } from "./support.mjs";

/** The string value of `key` inside the `legal.accessibility` block of config.ts. */
function accessibilityConfig(key) {
  const block = fs.readFileSync("config.ts", "utf8").match(/accessibility:\s*\{([^}]*)\}/)?.[1];
  const value = block?.match(new RegExp(`${key}:\\s*"([^"]*)"`))?.[1];
  assert.ok(value, `config.ts should set legal.accessibility.${key} to a string`);
  return value;
}

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
  for (const key of ["contactEmail", "reviewDate"]) {
    const value = accessibilityConfig(key);
    assert.ok(html.includes(value), `/legal/accessibility should show legal.accessibility.${key} ("${value}")`);
  }
  assert.ok(
    html.includes(`href="mailto:${accessibilityConfig("contactEmail")}"`),
    "the contact address should be a mailto: link"
  );
  assert.match(html, /WCAG 2\.2/, "the statement should name its target standard");
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
