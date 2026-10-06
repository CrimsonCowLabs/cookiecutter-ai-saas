// No account is created for anyone under the configured minimum age, whichever
// way they sign in — run against a REALLY RUNNING app (scripts/check_compliance.sh
// boots one), driving the same HTTP requests a browser would make. See
// docs/compliance.md, "Children's privacy (COPPA)", for why.
//
// Every sign-in method the app offers is read off its own /api/auth/providers,
// so a provider added later is covered without editing this file. OAuth
// sign-ins go through a fake identity provider (./fake-oidc.mjs); magic-link
// sign-ins use a sign-in link minted straight into the database, the way
// tests/auth/support.mjs mints session cookies — nothing here needs a real
// Google account or a real inbox.
//
// The minimum age is read out of config.ts, so the boundary tests below follow
// it: CI also runs this file with the age raised (see
// .github/workflows/generate-and-build.yml) to prove the line moves with it.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus FAKE_OIDC_PORT (see ./fake-oidc.mjs) and,
// optionally, SERVER_LOG — the app's log file, checked for dates of birth.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { config, connectDb, insertTestUser, deleteTestUser } from "../auth/support.mjs";
import { startFakeOidc } from "./fake-oidc.mjs";
import { minimumAge } from "./support.mjs";

const MINIMUM_AGE = minimumAge();

let idp;
let db;
let providers;
// Every email a test signs in with, so after() can delete whatever it created.
const emails = new Set();

before(async () => {
  idp = await startFakeOidc();
  db = await connectDb();
  providers = Object.values(await (await fetch(new URL("/api/auth/providers", config.baseUrl))).json());
  assert.ok(providers.length > 0, "the app should offer at least one way to sign in");
});

after(async () => {
  if (db && emails.size) await db.query(`delete from users where email = any($1)`, [[...emails]]);
  await db?.end();
  await idp?.close();
});

// ─── A browser, minus the browser ────────────────────────────────────────

/** A cookie jar and fetch() that sends and keeps cookies the way a browser does. */
function visitor() {
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

const location = (res) => {
  assert.ok(res.status >= 300 && res.status < 400, `expected a redirect, got ${res.status} for ${res.url}`);
  return new URL(res.headers.get("location"), config.baseUrl);
};

const hasSession = (v) => [...v.jar.keys()].some((k) => k.endsWith("authjs.session-token"));

// ─── The age screen ──────────────────────────────────────────────────────

/**
 * The date `years` years and `days` days before today (UTC), as YYYY-MM-DD.
 * On 29 February, a year with no 29th gives the 28th (that birthday has
 * passed), not 1 March.
 */
function bornAgo(years, days = 0) {
  const now = new Date();
  const year = now.getUTCFullYear() - years;
  const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, now.getUTCMonth(), Math.min(now.getUTCDate(), lastDay) - days));
  return d.toISOString().slice(0, 10);
}

/** The age screen's form on `html`: where it posts, its hidden fields, and its date input. */
function ageScreen(html) {
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
async function answerAgeScreen(v, dateOfBirth) {
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
async function passedVisitor() {
  const v = visitor();
  location(await answerAgeScreen(v, bornAgo(MINIMUM_AGE + 20)));
  return v;
}

const signUpPage = async (v) => (await v.fetch("/sign-up")).text();
const offersSignUp = (html) => /Send magic link|Continue with (Google|Microsoft)/.test(html);

// ─── Signing in, per provider ────────────────────────────────────────────

/**
 * Sign in as `email` through `provider`, the way a browser would from the
 * sign-in page: OAuth via the fake identity provider, magic link via a link
 * minted into verification_tokens and then opened. Returns where the app's
 * callback sent the visitor.
 */
async function signInThrough(v, provider, email) {
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
  callback.search = idp.issue(authorize, { sub: `sub-${crypto.randomUUID()}`, email }).toString();
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

const newEmail = () => `age-gate-test-${crypto.randomUUID()}@example.invalid`;
// age_check_passed_at is a timestamp without a time zone holding UTC (like
// every timestamp in lib/db/schema.ts); read it as epoch milliseconds so the
// machine's own time zone can't shift it.
const userRow = async (email) =>
  (
    await db.query(
      `select id, extract(epoch from age_check_passed_at) * 1000 as passed_ms from users where email = $1`,
      [email]
    )
  ).rows[0];

// ─── Tests ───────────────────────────────────────────────────────────────

test("the sign-up page asks for a date of birth before it offers any way to sign up", async () => {
  const html = await signUpPage(visitor());
  const screen = ageScreen(html);
  assert.ok(screen, "/sign-up should show a form with a date input");
  assert.ok(!offersSignUp(html), "no sign-in button or magic-link form should show before the age screen is answered");

  // A server-handled form: it posts to the server, which needs no JavaScript.
  assert.equal(screen.method, "post", "the age screen should be a method=post form");
  assert.ok(screen.action?.startsWith("/"), "the age screen should post to this app");

  // Labelled, and neutral: no pre-filled date, and no hint of the right answer.
  assert.ok(screen.dateId && new RegExp(`<label[^>]*for="${screen.dateId}"`).test(html), "the date input should have a <label>");
  assert.ok(!/\svalue="[^"]+"/.test(screen.dateInput), "the date input should start empty, not default to an adult age");
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ");
  assert.ok(
    !new RegExp(`\\b${MINIMUM_AGE}\\b`).test(text) && !/\b(at least|or older|or over|must be)\b/i.test(text),
    "the age screen should not say what age is needed"
  );
});

test("an invalid date of birth is refused with an error a screen reader announces", async () => {
  for (const bad of ["", "not-a-date", "2001-02-30", bornAgo(-1)]) {
    const v = visitor();
    const where = location(await answerAgeScreen(v, bad));
    assert.equal(where.pathname, "/sign-up", `"${bad}" should send the visitor back to the age screen`);
    assert.ok(!v.setCookies.some((c) => /age-check/i.test(c)), `"${bad}" should neither pass nor turn the visitor away`);

    const html = await (await v.fetch(where.pathname + where.search)).text();
    const screen = ageScreen(html);
    assert.ok(screen, `after "${bad}" the age screen should still be there`);
    const describedBy = screen.dateInput.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(/aria-invalid="true"/.test(screen.dateInput), "the date input should be marked aria-invalid");
    assert.ok(describedBy, "the date input should point at its error with aria-describedby");
    assert.match(html, new RegExp(`id="${describedBy}"[^>]*role="alert"|role="alert"[^>]*id="${describedBy}"`), "the error should be a role=alert");
  }
});

test("the line sits exactly at the configured minimum age", async () => {
  const onBirthday = visitor();
  location(await answerAgeScreen(onBirthday, bornAgo(MINIMUM_AGE)));
  assert.ok(offersSignUp(await signUpPage(onBirthday)), `someone turning ${MINIMUM_AGE} today should be let through`);

  const dayShort = visitor();
  location(await answerAgeScreen(dayShort, bornAgo(MINIMUM_AGE, -1)));
  const html = await signUpPage(dayShort);
  assert.ok(!offersSignUp(html) && !ageScreen(html), `someone turning ${MINIMUM_AGE} tomorrow should be turned away`);
});

test("an under-age visitor is turned away, stays turned away, and no account is created for them", async () => {
  const v = visitor();
  const dateOfBirth = bornAgo(MINIMUM_AGE - 3, 40);
  assert.equal(location(await answerAgeScreen(v, dateOfBirth)).pathname, "/sign-up");

  const html = await signUpPage(v);
  assert.ok(!offersSignUp(html), "a turned-away visitor should not be offered a way to sign up");
  assert.ok(!ageScreen(html), "a turned-away visitor should not be asked again");
  assert.match(html, /can(&#x27;|')t create an account/i, "the visitor should be told, plainly, that they can't create an account");

  // Retrying with an adult date changes nothing while the refusal lasts.
  const retry = await v.fetch(ageScreen(await signUpPage(visitor())).action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ dateOfBirth: bornAgo(MINIMUM_AGE + 30) }),
  });
  assert.equal(location(retry).pathname, "/sign-up");
  assert.ok(!offersSignUp(await signUpPage(v)), "a retry with another date should still be turned away");

  // And no sign-in method creates the account behind the screen's back, even
  // carrying a "passed" cookie from somewhere else.
  const passed = await passedVisitor();
  for (const [name, value] of passed.jar) if (/age-check/i.test(name)) v.jar.set(name, value);
  for (const provider of providers) {
    const email = newEmail();
    const where = await signInThrough(v, provider, email);
    assert.equal(where.pathname, "/sign-up", `${provider.id}: a turned-away visitor should be sent back to the age screen`);
    assert.equal(await userRow(email), undefined, `${provider.id}: no user row should be created`);
  }
  assert.ok(!hasSession(v), "a turned-away visitor should never be signed in");
  await assertNoDateOfBirth(dateOfBirth, v.setCookies);
});

test("no sign-in method creates an account without a passed age check", async () => {
  for (const provider of providers) {
    const v = visitor();
    const email = newEmail();
    const where = await signInThrough(v, provider, email);
    assert.equal(where.pathname, "/sign-up", `${provider.id}: a new account should be sent to the age screen`);
    assert.ok(ageScreen(await (await v.fetch(where.pathname + where.search)).text()), `${provider.id}: and shown it`);
    assert.equal(await userRow(email), undefined, `${provider.id}: no user row should be created`);
    assert.ok(!hasSession(v), `${provider.id}: the visitor should not be signed in`);
  }

  // Asking for a magic link is refused up front, before any email is sent.
  for (const provider of providers.filter((p) => p.type === "email")) {
    const email = newEmail();
    const where = await requestMagicLink(visitor(), provider, email);
    assert.equal(where.pathname, "/sign-up", "asking for a magic link for a new account should go to the age screen");
    const { rows } = await db.query(`select 1 from verification_tokens where identifier = $1`, [email]);
    assert.equal(rows.length, 0, "no sign-in link should be issued for a new account without an age check");
  }
});

test("a passed age check creates the account with when it was passed, and the date of birth is kept nowhere", async () => {
  for (const provider of providers) {
    const v = visitor();
    const dateOfBirth = bornAgo(MINIMUM_AGE + 11, 123);
    const before = new Date();
    location(await answerAgeScreen(v, dateOfBirth));

    const email = newEmail();
    const where = await signInThrough(v, provider, email);
    assert.equal(where.pathname, "/dashboard", `${provider.id}: a visitor who passed should land on the dashboard`);
    assert.ok(hasSession(v), `${provider.id}: and be signed in`);

    const row = await userRow(email);
    assert.ok(row, `${provider.id}: a user row should be created`);
    assert.ok(row.passed_ms, `${provider.id}: users.age_check_passed_at should be set`);
    const passedAt = Number(row.passed_ms);
    assert.ok(
      passedAt >= before.getTime() - 1000 && passedAt <= Date.now(),
      `${provider.id}: age_check_passed_at should be when the screen was answered`
    );
    await assertNoDateOfBirth(dateOfBirth, v.setCookies);
  }
});

test("an existing user signs in through every method without seeing the age screen", async () => {
  for (const provider of providers) {
    const user = await insertTestUser(db);
    try {
      const v = visitor();
      const where = await signInThrough(v, provider, user.email);
      assert.equal(where.pathname, "/dashboard", `${provider.id}: an existing user should go straight to the dashboard`);
      assert.ok(hasSession(v), `${provider.id}: and be signed in`);
      assert.equal(
        (await db.query(`select age_check_passed_at from users where id = $1`, [user.id])).rows[0].age_check_passed_at,
        null,
        `${provider.id}: an existing account is grandfathered, not stamped`
      );
    } finally {
      await deleteTestUser(db, user.id);
    }
  }
});

// ─── Date of birth, nowhere ──────────────────────────────────────────────

/**
 * `dateOfBirth` (YYYY-MM-DD) appears in no cookie the app set, no row of any
 * table, and — when SERVER_LOG names it — not in the app's log either. Checked
 * in the usual ways a date gets written down.
 */
async function assertNoDateOfBirth(dateOfBirth, setCookies) {
  const [y, m, d] = dateOfBirth.split("-");
  const forms = [dateOfBirth, `${y}${m}${d}`, `${m}/${d}/${y}`, `${d}/${m}/${y}`, `${d}.${m}.${y}`];
  const found = (where, text) => {
    const form = forms.find((f) => text.includes(f) || decodeURIComponent(text).includes(f));
    assert.equal(form, undefined, `the date of birth (${form}) was found in ${where}`);
  };

  for (const cookie of setCookies) found("a cookie", cookie);

  const { rows: tables } = await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  for (const { table_name } of tables) {
    const { rows } = await db.query(`select t::text as row from "${table_name}" t`);
    for (const { row } of rows) found(`the ${table_name} table`, row);
  }

  if (process.env.SERVER_LOG) found("the server log", fs.readFileSync(process.env.SERVER_LOG, "utf8"));
}
