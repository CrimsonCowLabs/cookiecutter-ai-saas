// Shared helpers for tests/auth/auth.test.mjs — kept separate so the test
// file itself reads as a list of access rules, not plumbing.
//
// Zero new dependencies: "pg" is already a runtime dependency (see
// package.json), and @auth/core is not listed there at all, but it is pulled
// in as a transitive dependency of next-auth and pinned in package-lock.json
// — `npm ci` puts it at the top level of node_modules, so it resolves here
// the same way it does inside next-auth itself. If next-auth ever stops
// depending on @auth/core, or bumps across a version that changes this, the
// import below starts failing loudly rather than silently testing nothing.
import crypto from "node:crypto";
import pg from "pg";
import { encode } from "@auth/core/jwt";

const DEFAULT_BASE_URL = "http://localhost:3000";
// A fixed, low-entropy placeholder, not a real credential — the same idea as
// the dummy NEXTAUTH_SECRET scripts/check_tls_stack.sh writes into its own
// throwaway env file. scripts/check_auth.sh sets this exact value as the
// NEXTAUTH_SECRET of the server it boots AND as the NEXTAUTH_SECRET these
// tests run with, so the default here only has to agree with that script.
// Running this by hand against a real project: export NEXTAUTH_SECRET to
// that project's own secret first, or minting a session cookie the app
// actually accepts is impossible.
const DEFAULT_NEXTAUTH_SECRET =
  "0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres";

export const config = {
  baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL,
  nextAuthSecret: process.env.NEXTAUTH_SECRET || DEFAULT_NEXTAUTH_SECRET,
  databaseUrl: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
};

/** A connected pg client. Caller is responsible for `.end()`ing it. */
export async function connectDb() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  return client;
}

/**
 * Inserts a real row into `users` over a raw SQL insert — not drizzle, so
 * this needs no TypeScript build step and no schema import, just the `pg`
 * driver these tests already depend on. The email is unique per call so
 * concurrent test runs (or a re-run after a crash that skipped cleanup)
 * cannot collide on the table's unique constraint.
 */
export async function insertTestUser(db, { isAdmin = false } = {}) {
  const id = crypto.randomUUID();
  const email = `auth-integration-test-${id}@example.invalid`;
  const name = "Auth Integration Test User";
  await db.query(
    `insert into users (id, email, name, is_admin) values ($1, $2, $3, $4)`,
    [id, email, name, isAdmin]
  );
  return { id, email, name };
}

export async function deleteTestUser(db, id) {
  await db.query(`delete from users where id = $1`, [id]);
}

// Auth.js v5 (next-auth beta) issues an encrypted JWE, not a signed-and-legible
// JWT, so a session cookie can only be produced through @auth/core's own
// `encode()` — there is no shortcut that skips the app's actual crypto. Two
// details of the shape below are not part of any documented public contract
// and were confirmed empirically (see the issue: boot the app against a real
// Postgres, mint a cookie, hit an authenticated route, check it actually
// works) rather than assumed:
//
//   - The cookie name. Auth.js prefixes it "__Secure-" only when the app
//     considers the request HTTPS; every environment these tests run in
//     (scripts/check_auth.sh, and a developer's own localhost) talks plain
//     http://localhost, so the unprefixed name applies.
//   - The salt @auth/core's `encode()`/`decode()` use to derive the JWE
//     encryption key from the secret is the cookie name itself (see
//     @auth/core/src/jwt.ts — `getToken()` defaults `salt` to `cookieName`).
//     Get this wrong and decode() on the server throws, which surfaces here
//     as an unauthenticated request rather than a decode error, so it is
//     worth restating: the salt is not a separate secret, it is this name.
//
// The token payload only has to satisfy lib/auth.config.ts's `session`
// callback, which reads `token.id` into `session.user.id`
// (app/(main)/dashboard/admin/page.tsx then looks up that id's `isAdmin`
// column) — `sub`/`email`/`name` are included because DefaultJWT normally
// carries them, not because anything here reads them back.
const SESSION_COOKIE_NAME = "authjs.session-token";

/** A `Cookie:` header value carrying a real, validly-encrypted session for `user`. */
export async function mintSessionCookie(user) {
  const jwt = await encode({
    secret: config.nextAuthSecret,
    salt: SESSION_COOKIE_NAME,
    token: { id: user.id, sub: user.id, email: user.email, name: user.name },
  });
  return `${SESSION_COOKIE_NAME}=${jwt}`;
}
