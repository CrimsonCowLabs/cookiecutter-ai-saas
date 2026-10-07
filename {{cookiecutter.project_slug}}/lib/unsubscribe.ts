import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import config from "@/config";
import { db } from "@/lib/db";
import { emailSuppressions } from "@/lib/db/schema";

/**
 * Opting out of marketing email (CAN-SPAM; see docs/compliance.md).
 *
 * Every marketing email carries a link with a token naming its recipient,
 * signed with the auth secret. The token never expires: CAN-SPAM requires
 * the opt-out to keep working for at least 30 days after sending, and an old
 * email's link that quietly stopped working would be the worst way to fail
 * that. Anyone holding a genuine token can only ever opt that one address
 * out, which is harmless.
 *
 * An opt-out is a row in `email_suppressions`, keyed by the normalised
 * address and independent of `users`: nothing here looks up or reveals
 * whether the address has an account.
 *
 * Node.js runtime only (node:crypto).
 */

export type SuppressionSource = "unsubscribe-page" | "one-click" | (string & {});

/** The form an address is compared and stored in: trimmed and lower-cased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function secret(): string {
  const value = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("NEXTAUTH_SECRET is not set; unsubscribe links cannot be signed");
  return value;
}

function signature(email: string): string {
  return crypto.createHmac("sha256", secret()).update(`unsubscribe:${email}`).digest("base64url");
}

/** The signed, non-expiring token for `email`'s unsubscribe links. */
export function unsubscribeToken(email: string): string {
  const address = normaliseEmail(email);
  return `${Buffer.from(address).toString("base64url")}.${signature(address)}`;
}

/** The address `token` names, or null unless it is genuine. */
export function readUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const [encoded, sig, ...rest] = token.split(".");
  if (!encoded || !sig || rest.length) return null;
  const address = Buffer.from(encoded, "base64url").toString("utf8");
  if (!address.includes("@") || address !== normaliseEmail(address)) return null;
  const expected = Buffer.from(signature(address));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return address;
}

const site = () => process.env.NEXTAUTH_URL || `https://${config.domainName}`;

/**
 * Where an email's footer sends a reader: the confirmation page
 * (app/(main)/unsubscribe/page.tsx), with one button.
 */
export function unsubscribePageUrl(email: string): string {
  return `${site()}/unsubscribe?token=${unsubscribeToken(email)}`;
}

/**
 * The List-Unsubscribe header's URL (app/api/unsubscribe/route.ts): a mail
 * client POSTs here for RFC 8058 one-click, and a GET is sent on to the
 * confirmation page.
 */
export function unsubscribeEndpointUrl(email: string): string {
  return `${site()}/api/unsubscribe?token=${unsubscribeToken(email)}`;
}

/**
 * Opt `email` out of marketing email. Idempotent: the first opt-out's time
 * and source are kept, and repeating it changes nothing.
 */
export async function suppress(email: string, source: SuppressionSource): Promise<void> {
  await db
    .insert(emailSuppressions)
    .values({ email: normaliseEmail(email), source })
    .onConflictDoNothing();
}

/** Whether `email` has opted out of marketing email. */
export async function isSuppressed(email: string): Promise<boolean> {
  const [row] = await db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, normaliseEmail(email)))
    .limit(1);
  return Boolean(row);
}
