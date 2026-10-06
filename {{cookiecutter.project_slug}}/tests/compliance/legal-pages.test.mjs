// The legal hub at /legal and its subpages are there, reachable without
// signing in, and linked from the landing page's footer — run against a REALLY
// RUNNING app (scripts/check_compliance.sh boots one). Several of these pages
// are the notice a law requires the app to show, so "the route exists in the
// source tree" is not enough: a visitor has to be able to load it.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { config, links } from "./support.mjs";

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
