// A Microsoft sign-in never takes over someone else's account. In Microsoft
// Entra ID the `email` claim is whatever a tenant's admin typed in, and
// nothing checks it, so anyone can make a tenant of their own, give a user
// the victim's address, and sign in as them (the published "nOAuth" attack)
// — if the app links a sign-in to the existing account with that email. It
// links one only when the ID token proves the email can be trusted: Microsoft
// says the domain is verified (`xms_edov`), or the app is configured for one
// tenant and the sign-in is by a member of it. See lib/account-linking.ts.
//
// The rule is tested on its own first (this file loads lib/account-linking.ts
// itself, through tsx, as marketing-email.test.mjs does), then against the
// running app (scripts/check_compliance.sh boots one), signing in through
// the fake identity provider (./fake-oidc.mjs) as an attacker would. The
// compliance runner leaves MICROSOFT_ENTRA_ID_TENANT_ID unset: the app is
// multi-tenant, the default and the case the attack needs, and where the
// tenant a sign-in comes from proves nothing. The ID tokens it issues carry
// no `tid`: given one, Auth.js looks that tenant's sign-in server up again,
// over HTTPS only, which the fake isn't. The single-tenant rule is tested
// on its own below.
//
// Only ships in projects that offer Microsoft sign-in.
//
// Env vars (see tests/auth/support.mjs for defaults): BASE_URL,
// NEXTAUTH_SECRET, DATABASE_URL; plus FAKE_OIDC_PORT (see ./fake-oidc.mjs).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { config, connectDb, insertTestUser, deleteTestUser } from "../auth/support.mjs";
import { startFakeOidc } from "./fake-oidc.mjs";
import { launchBrowser, withPage } from "./support.mjs";
import { visitor, hasSession, passedVisitor, signingIn } from "./sign-in.mjs";

// The project's .ts files are CommonJS to Node, so both of tsx's loaders are
// needed, and the exports arrive on `.default` (see marketing-email.test.mjs).
registerEsm();
registerCjs();
const { mayLinkByEmail, MICROSOFT_PROVIDER_ID: MICROSOFT } = (await import("../../lib/account-linking.ts")).default;

const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";

// ─── The rule ────────────────────────────────────────────────────────────

describe("whether a sign-in may be linked to an existing account by its email", () => {
  test("Microsoft, when it says the email's domain is verified", () => {
    for (const tenantId of [undefined, "", "common", TENANT]) {
      assert.equal(mayLinkByEmail(MICROSOFT, { tid: OTHER_TENANT, xms_edov: true }, tenantId), true, `tenant "${tenantId}"`);
    }
  });

  test("not Microsoft without that, from any tenant, when the app takes any tenant", () => {
    for (const tenantId of [undefined, "", "  ", "common", "organizations", "consumers", "COMMON"]) {
      for (const profile of [{ tid: OTHER_TENANT }, { tid: OTHER_TENANT, xms_edov: false }, {}, undefined]) {
        assert.equal(mayLinkByEmail(MICROSOFT, profile, tenantId), false, `tenant "${tenantId}", ${JSON.stringify(profile)}`);
      }
      // A multi-tenant app has no tenant of its own to trust, whatever `tid` says.
      assert.equal(mayLinkByEmail(MICROSOFT, { tid: tenantId }, tenantId), false, `tenant "${tenantId}" as tid`);
    }
  });

  test("only a real true counts as verified", () => {
    // Microsoft documents xms_edov as a boolean.
    for (const xms_edov of ["true", "1", 1, "yes", null]) {
      assert.equal(mayLinkByEmail(MICROSOFT, { xms_edov }, undefined), false, JSON.stringify(xms_edov));
    }
  });

  test("Microsoft from the one tenant the app is configured for", () => {
    assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT }, TENANT), true);
    assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT.toUpperCase() }, TENANT), true, "tenant ids are GUIDs, compared without case");
  });

  test("Microsoft from the configured tenant whose idp is that tenant", () => {
    // What a member's token may carry: idp, when present, is the issuer.
    const iss = `https://login.microsoftonline.com/${TENANT}/v2.0`;
    assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT, iss, idp: iss }, TENANT), true);
    assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT, idp: `https://sts.windows.net/${TENANT}/` }, TENANT), true);
  });

  test("not a guest in the configured tenant, whose email comes from their home tenant", () => {
    const iss = `https://login.microsoftonline.com/${TENANT}/v2.0`;
    for (const idp of [`https://sts.windows.net/${OTHER_TENANT}/`, "live.com", "https://sts.windows.net/9188040d-6c67-4c5b-b112-36a304b66dad/", "", 42]) {
      assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT, iss, idp }, TENANT), false, JSON.stringify(idp));
      // Unless Microsoft verified the email's domain itself.
      assert.equal(mayLinkByEmail(MICROSOFT, { tid: TENANT, iss, idp, xms_edov: true }, TENANT), true, `${JSON.stringify(idp)} with xms_edov`);
    }
  });

  test("not Microsoft from any other tenant than the configured one", () => {
    assert.equal(mayLinkByEmail(MICROSOFT, { tid: OTHER_TENANT }, TENANT), false);
    assert.equal(mayLinkByEmail(MICROSOFT, {}, TENANT), false, "no tid");
  });

  test("other providers, whose emails are verified, as before", () => {
    assert.equal(mayLinkByEmail("google", { email_verified: true }, undefined), true);
    assert.equal(mayLinkByEmail("resend", undefined, undefined), true, "a magic link proves the inbox itself");
  });
});

// ─── Against the running app ─────────────────────────────────────────────

describe("against the running app", () => {
  let idp;
  let db;
  let browser;
  let microsoft;
  let emails, signInThrough;

  before(async () => {
    idp = await startFakeOidc();
    db = await connectDb();
    browser = await launchBrowser();
    ({ emails, signInThrough } = signingIn({ idp, db }));
    const providers = Object.values(await (await fetch(new URL("/api/auth/providers", config.baseUrl))).json());
    microsoft = providers.find((p) => p.id === MICROSOFT);
    assert.ok(microsoft, `the app should offer ${MICROSOFT}; this file only ships with Microsoft sign-in`);
  });

  after(async () => {
    if (db && emails?.size) await db.query(`delete from users where email = any($1)`, [[...emails]]);
    await db?.end();
    await idp?.close();
    await browser?.close();
  });

  const linkedAccounts = async (userId) =>
    (await db.query(`select provider, provider_account_id from accounts where user_id = $1`, [userId])).rows;
  const usersWith = async (email) =>
    Number((await db.query(`select count(*) from users where email = $1`, [email])).rows[0].count);

  test("a sign-in from another tenant with the victim's email, unverified, is refused", async () => {
    const victim = await insertTestUser(db);
    try {
      // Having passed the age screen changes nothing: the refusal is not the age gate's.
      let where;
      for (const v of [visitor(), await passedVisitor()]) {
        where = await signInThrough(v, microsoft, victim.email);
        assert.equal(where.pathname, "/sign-in", "the attacker should be sent back to the sign-in page");
        assert.equal(where.searchParams.get("error"), "OAuthAccountNotLinked", "with Auth.js's error for an email that belongs to another sign-in");
        assert.ok(!hasSession(v), "the attacker should not be signed in");
        assert.deepEqual(await linkedAccounts(victim.id), [], "no Microsoft account should be linked to the victim");
        assert.equal(await usersWith(victim.email), 1, "and no second account made with the victim's email");
      }
      // What the sign-in page then tells them.
      const alert = await withPage(browser, where.pathname + where.search, {}, ({ page }) =>
        page.$eval('[role="alert"]', (el) => el.textContent).catch(() => null)
      );
      assert.match(alert ?? "", /already has an account/, "the sign-in page should say why, as an alert");
    } finally {
      await deleteTestUser(db, victim.id);
    }
  });

  test("a sign-in whose email Microsoft verified is linked to the existing account", async () => {
    const user = await insertTestUser(db);
    try {
      const v = visitor();
      const sub = `sub-${crypto.randomUUID()}`;
      const where = await signInThrough(v, microsoft, user.email, { sub, claims: { xms_edov: true } });
      assert.equal(where.pathname, "/dashboard", "the user should land on the dashboard");
      assert.ok(hasSession(v), "and be signed in");
      assert.deepEqual(await linkedAccounts(user.id), [{ provider: MICROSOFT, provider_account_id: sub }]);
    } finally {
      await deleteTestUser(db, user.id);
    }
  });

  test("a first-time Microsoft sign-in creates an account, and its user signs in again without proof", async () => {
    const email = `account-linking-test-${crypto.randomUUID()}@example.invalid`;
    const sub = `sub-${crypto.randomUUID()}`;

    const first = await passedVisitor();
    const created = await signInThrough(first, microsoft, email, { sub });
    assert.equal(created.pathname, "/dashboard", "a new Microsoft user should land on the dashboard");
    assert.ok(hasSession(first), "and be signed in");
    const { rows } = await db.query(`select id from users where email = $1`, [email]);
    assert.equal(rows.length, 1, "one account should be created");
    assert.deepEqual(await linkedAccounts(rows[0].id), [{ provider: MICROSOFT, provider_account_id: sub }]);

    // Returning: the same Microsoft account, already linked, from a browser
    // that has not been through the age screen.
    const again = visitor();
    const returned = await signInThrough(again, microsoft, email, { sub });
    assert.equal(returned.pathname, "/dashboard", "a returning Microsoft user should land on the dashboard");
    assert.ok(hasSession(again), "and be signed in");
    assert.equal(await usersWith(email), 1, "without a second account");
  });
});
