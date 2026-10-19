// Signing in and signing up against the running app, the way a browser would
// but without one: a cookie jar, the age screen, and a sign-in through any
// provider the app offers — OAuth by way of the fake identity provider
// (./fake-oidc.mjs), magic link by way of a sign-in link minted straight into
// the database, the way tests/auth/support.mjs mints session cookies.
//
// Shared by the compliance tests that sign in, such as ./age-gate.test.mjs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../auth/support.mjs";
import { minimumAge } from "./support.mjs";

// ─── A browser, minus the browser ────────────────────────────────────────

/** A cookie jar and fetch() that sends and keeps cookies the way a browser does. */
export function visitor() {
  const jar = new Map();
  const absorb = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const name = pair.slice(0, pair.indexOf("=")).trim();
      const value = pair.slice(pair.indexOf("=") + 1).trim();
      const expired =
        value === "" ||
        attrs.some((a) => /^\s*max-age=(0|-)/i.test(a)) ||
        attrs.some((a) => /^\s*expires=/i.test(a) && new Date(a.split("=")[1]) < new Date());
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
  };
  return {
    jar,
    setCookies: [],
    async fetch(path, init = {}) {
      const res = await fetch(new URL(path, config.baseUrl), {
        redirect: "manual",
        ...init,
        headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      });
      this.setCookies.push(...res.headers.getSetCookie());
      absorb(res);
      return res;
    },
  };
}

/** Where the redirect `res` points, as a URL on the app. */
export const location = (res) => {
  assert.ok(res.status >= 300 && res.status < 400, `expected a redirect, got ${res.status} for ${res.url}`);
  return new URL(res.headers.get("location"), config.baseUrl);
};

/** Whether the visitor `v` holds a session cookie. */
export const hasSession = (v) => [...v.jar.keys()].some((k) => k.endsWith("authjs.session-token"));

// ─── The age screen ──────────────────────────────────────────────────────

/**
 * The date `years` years and `days` days before today (UTC), as YYYY-MM-DD.
 * On 29 February, a year with no 29th gives the 28th (that birthday has
 * passed), not 1 March.
 */
export function bornAgo(years, days = 0) {
  const now = new Date();
  const year = now.getUTCFullYear() - years;
  const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, now.getUTCMonth(), Math.min(now.getUTCDate(), lastDay) - days));
  return d.toISOString().slice(0, 10);
}

/** The age screen's form on `html`: where it posts, its hidden fields, and its date input. */
export function ageScreen(html) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)?.find((f) => /type="date"/.test(f));
  if (!form) return null;
  const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const inputs = form.match(/<input\b[^>]*>/g) ?? [];
  const dateInput = inputs.find((i) => attr(i, "type") === "date");
  return {
    form,
    method: attr(form.match(/<form\b[^>]*>/)[0], "method"),
    action: attr(form.match(/<form\b[^>]*>/)[0], "action"),
    hidden: Object.fromEntries(
      inputs.filter((i) => attr(i, "type") === "hidden").map((i) => [attr(i, "name"), attr(i, "value") ?? ""])
    ),
    dateInput,
    dateName: attr(dateInput, "name"),
    dateId: attr(dateInput, "id"),
  };
}

/** Load the sign-up page as `v` and answer its age screen with `dateOfBirth`. */
export async function answerAgeScreen(v, dateOfBirth) {
  const page = await v.fetch("/sign-up");
  assert.equal(page.status, 200);
  const screen = ageScreen(await page.text());
  assert.ok(screen, "/sign-up should show the age screen");
  return v.fetch(screen.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...screen.hidden, [screen.dateName]: dateOfBirth }),
  });
}

/** A visitor who has passed the age screen. */
export async function passedVisitor() {
  const v = visitor();
  location(await answerAgeScreen(v, bornAgo(minimumAge() + 20)));
  return v;
}

// ─── Signing in, per provider ────────────────────────────────────────────

/**
 * Sign-in helpers bound to the fake identity provider `idp` (a started
 * ./fake-oidc.mjs) and the database client `db`. `emails` collects every
 * address signed in with, so a test file's after() can delete whatever it
 * created.
 */
export function signingIn({ idp, db }) {
  const emails = new Set();

  /**
   * Sign in as `email` through `provider`, the way a browser would from the
   * sign-in page: OAuth via the fake identity provider, magic link via a link
   * minted into verification_tokens and then opened. For OAuth, `sub` is who
   * the provider says signed in (a new person each time unless given) and
   * `claims` are added to the ID token it issues. Returns where the app's
   * callback sent the visitor.
   */
  async function signInThrough(v, provider, email, { sub = `sub-${crypto.randomUUID()}`, claims } = {}) {
    emails.add(email);
    if (provider.type === "email") {
      const token = crypto.randomBytes(32).toString("hex");
      await db.query(
        `insert into verification_tokens (identifier, token, expires) values ($1, $2, now() + interval '1 hour')`,
        [email, crypto.createHash("sha256").update(`${token}${config.nextAuthSecret}`).digest("hex")]
      );
      return location(
        await v.fetch(
          `/api/auth/callback/${provider.id}?${new URLSearchParams({
            callbackUrl: new URL("/dashboard", config.baseUrl).href,
            token,
            email,
          })}`
        )
      );
    }

    const { csrfToken } = await (await v.fetch("/api/auth/csrf")).json();
    const start = await v.fetch(`/api/auth/signin/${provider.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, callbackUrl: new URL("/dashboard", config.baseUrl).href }),
    });
    const authorize = location(start);
    assert.notEqual(authorize.host, new URL(config.baseUrl).host, `${provider.id} should hand off to its identity provider`);
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    callback.search = idp.issue(authorize, { sub, email, claims }).toString();
    return location(await v.fetch(callback.pathname + callback.search));
  }

  /** Ask for a magic link as `email`. Returns where the app sent the visitor. */
  async function requestMagicLink(v, provider, email) {
    emails.add(email);
    const { csrfToken } = await (await v.fetch("/api/auth/csrf")).json();
    return location(
      await v.fetch(`/api/auth/signin/${provider.id}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken, email, callbackUrl: new URL("/dashboard", config.baseUrl).href }),
      })
    );
  }

  return { emails, signInThrough, requestMagicLink };
}
