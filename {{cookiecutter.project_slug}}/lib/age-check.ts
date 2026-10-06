import crypto from "node:crypto";
import config from "@/config";

/**
 * The age screen every new account passes first (COPPA; see
 * docs/compliance.md, "Children's privacy").
 *
 * Its answer lives only in a signed cookie, and only as "passed at <time>"
 * or "turned away at <time>": the date of birth itself is checked and
 * dropped, and is never stored, logged or sent back to the browser.
 * lib/auth.ts reads the cookie in the Auth.js signIn callback, the one place
 * every sign-in passes through before an account is created.
 *
 * Node.js runtime only (node:crypto), like lib/auth.ts.
 */

export const AGE_CHECK_PASSED_COOKIE = "age-check-passed";
export const AGE_CHECK_TURNED_AWAY_COOKIE = "age-check-turned-away";

// Long enough to finish signing up, including opening a magic link from the
// inbox in the same browser; short enough that a shared computer doesn't
// carry someone else's answer for long.
const PASSED_FOR_SECONDS = 60 * 60;
// Long enough that going back and picking another date doesn't work, which is
// what the FTC's guidance on neutral age screens asks for.
const TURNED_AWAY_FOR_SECONDS = 24 * 60 * 60;

export type AgeCheck =
  | { status: "unanswered" }
  | { status: "passed"; passedAt: Date }
  | { status: "turned-away" };

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

function secret(): string {
  const value = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("NEXTAUTH_SECRET is not set; the age check cannot sign its cookies");
  return value;
}

function signature(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(`age-check:${payload}`).digest("base64url");
}

function seal(name: string, at: number): string {
  return `${at}.${signature(`${name}.${at}`)}`;
}

/** When the cookie `name` was set, if its value is genuine and not yet expired. */
function unseal(cookies: CookieReader, name: string, maxAgeSeconds: number, now: number): number | null {
  const value = cookies.get(name)?.value;
  const [at, sig] = value?.split(".") ?? [];
  if (!at || !sig || !/^\d+$/.test(at)) return null;
  const expected = Buffer.from(signature(`${name}.${at}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const setAt = Number(at);
  return setAt <= now && now - setAt < maxAgeSeconds * 1000 ? setAt : null;
}

/** What this visitor's cookies say about the age screen. A refusal wins over a pass. */
export function readAgeCheck(cookies: CookieReader, now = Date.now()): AgeCheck {
  if (unseal(cookies, AGE_CHECK_TURNED_AWAY_COOKIE, TURNED_AWAY_FOR_SECONDS, now) !== null) {
    return { status: "turned-away" };
  }
  const passedAt = unseal(cookies, AGE_CHECK_PASSED_COOKIE, PASSED_FOR_SECONDS, now);
  return passedAt === null ? { status: "unanswered" } : { status: "passed", passedAt: new Date(passedAt) };
}

/**
 * A YYYY-MM-DD date of birth (what <input type="date"> submits), as midnight
 * UTC — or null unless it is a real calendar date, not in the future and not
 * implausibly long ago.
 */
export function parseDateOfBirth(raw: unknown, today = new Date()): Date | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!isRealDate || year < 1900 || date.getTime() > today.getTime()) return null;
  return date;
}

/** Whole years between `dateOfBirth` and `today`, both read in UTC. */
export function ageOn(dateOfBirth: Date, today = new Date()): number {
  const years = today.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const hadBirthday =
    today.getUTCMonth() > dateOfBirth.getUTCMonth() ||
    (today.getUTCMonth() === dateOfBirth.getUTCMonth() && today.getUTCDate() >= dateOfBirth.getUTCDate());
  return hadBirthday ? years : years - 1;
}

export function isOldEnough(dateOfBirth: Date, today = new Date()): boolean {
  return ageOn(dateOfBirth, today) >= config.legal.minimumAge;
}

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  // Lax, so it still arrives when Google, Microsoft or an emailed magic link
  // sends the visitor back to this app.
  sameSite: "lax" as const,
  secure: (process.env.NEXTAUTH_URL ?? "").startsWith("https://"),
  path: "/",
  maxAge,
});

/** The cookie that records a passed age check, as of `now`. */
export function passedCookie(now = Date.now()) {
  return {
    name: AGE_CHECK_PASSED_COOKIE,
    value: seal(AGE_CHECK_PASSED_COOKIE, now),
    ...cookieOptions(PASSED_FOR_SECONDS),
  };
}

/** The cookie that turns the visitor away for a day, as of `now`. */
export function turnedAwayCookie(now = Date.now()) {
  return {
    name: AGE_CHECK_TURNED_AWAY_COOKIE,
    value: seal(AGE_CHECK_TURNED_AWAY_COOKIE, now),
    ...cookieOptions(TURNED_AWAY_FOR_SECONDS),
  };
}
