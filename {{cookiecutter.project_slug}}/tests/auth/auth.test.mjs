// Authorization integration tests — run against a REALLY RUNNING instance of
// a generated project (scripts/check_auth.sh boots one), not against mocks or
// route handlers imported in-process. That is the point of this file:
// compilation and unit tests can't catch an authorization bug in middleware,
// because the bug that motivated this (see the comment at the top of
// middleware.ts) was a middleware that compiled cleanly and simply let every
// request through. Only a real HTTP request against a real running server,
// asserting on the response it actually returns, would have caught it.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL, NEXTAUTH_SECRET,
// DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  config,
  connectDb,
  insertTestUser,
  deleteTestUser,
  mintSessionCookie,
} from "./support.mjs";

function locationPath(res) {
  const location = res.headers.get("location");
  assert.ok(location, `expected a Location header on a ${res.status} response`);
  // Resolve against baseUrl: middleware may redirect with an absolute URL
  // (it builds one with `new URL(path, req.url)`) or a relative one.
  return new URL(location, config.baseUrl).pathname;
}

function assertRedirect(res) {
  assert.ok(
    res.status >= 300 && res.status < 400,
    `expected a redirect (3xx), got ${res.status} for ${res.url}`
  );
}

test("an unauthenticated request to a dashboard route redirects to sign-in", async () => {
  const res = await fetch(new URL("/dashboard", config.baseUrl), {
    redirect: "manual",
  });
  assertRedirect(res);
  assert.equal(locationPath(res), "/sign-in");

  // This generated app also re-checks auth() in the dashboard layout itself
  // (defense in depth added after the incident this issue is about), so
  // simply landing on /sign-in is not, on its own, proof that *middleware*
  // did the redirecting — reintroducing the historical bug and rerunning
  // this test confirmed exactly that: the two assertions above stayed green,
  // because the layout's own redirect() papered over middleware's failure to
  // protect the route at all. The header checks below are what actually
  // catch it: a redirect middleware issues itself, via its own
  // `NextResponse.redirect()`, short-circuits before the request ever reaches
  // Next's page-render pipeline; a redirect thrown from inside the layout's
  // own `redirect()` call is that pipeline's own output. Two independent,
  // empirically-confirmed signals of "this went through the render
  // pipeline", not one, so that one config change doesn't quietly defeat this
  // check: `X-Powered-By` is a generic header the pipeline adds, with a
  // documented one-line opt-out (`poweredByHeader: false` in next.config.ts)
  // that has nothing to do with auth and could plausibly get flipped later;
  // `Vary: ..., next-router-state-tree, ...` is the App Router's own RSC
  // content-negotiation header, which an app doesn't get to turn off.
  assert.equal(
    res.headers.get("x-powered-by"),
    null,
    "the redirect should come from middleware itself, not from a page render " +
      "(x-powered-by present means the request reached the page/layout, i.e. " +
      "middleware treated the route as public)"
  );
  assert.ok(
    !(res.headers.get("vary") ?? "").includes("next-router-state-tree"),
    "the redirect should come from middleware itself, not from a page render " +
      "(a vary: next-router-state-tree header means the request reached the " +
      "page/layout, i.e. middleware treated the route as public)"
  );
});

test("public marketing routes remain reachable unauthenticated", async () => {
  // Every entry in middleware.ts's public list that is not gated behind a
  // cookiecutter flag, plus /blog and /contact — scripts/check_auth.sh
  // generates the project this runs against with include_marketing_extras=yes
  // specifically so those two exist to assert on (see cookiecutter.json /
  // .github/workflows/generate-and-build.yml's flag-matrix job: with the flag
  // off, those routes are removed from the generated project entirely).
  const publicRoutes = ["/", "/sign-in", "/privacy-policy", "/tos", "/blog", "/contact"];
  for (const path of publicRoutes) {
    const res = await fetch(new URL(path, config.baseUrl), { redirect: "manual" });
    assert.equal(res.status, 200, `${path} should be reachable unauthenticated, got ${res.status}`);
  }
});

test("a non-admin user is refused the admin area", async () => {
  const db = await connectDb();
  try {
    const user = await insertTestUser(db, { isAdmin: false });
    try {
      const cookie = await mintSessionCookie(user);

      const adminRes = await fetch(new URL("/dashboard/admin", config.baseUrl), {
        redirect: "manual",
        headers: { cookie },
      });
      // app/(main)/dashboard/admin/page.tsx redirects to /sign-in when there
      // is no session at all, and to /dashboard when there is a session but
      // isAdmin is false. Asserting specifically on /dashboard, not just "any
      // redirect", is what tells the two apart: it proves the session was
      // accepted and the admin check itself is what said no — a rejected or
      // undecryptable cookie would show up here as a redirect to /sign-in
      // instead, which the next assertion also rules out directly.
      assertRedirect(adminRes);
      assert.equal(locationPath(adminRes), "/dashboard");

      // The same cookie reaching an ordinary dashboard route confirms it
      // really is a valid, accepted session — not a coincidentally-redirecting
      // bad one.
      const dashboardRes = await fetch(new URL("/dashboard", config.baseUrl), {
        redirect: "manual",
        headers: { cookie },
      });
      assert.equal(dashboardRes.status, 200, "the minted session should authenticate on an ordinary dashboard route");
    } finally {
      await deleteTestUser(db, user.id);
    }
  } finally {
    await db.end();
  }
});
