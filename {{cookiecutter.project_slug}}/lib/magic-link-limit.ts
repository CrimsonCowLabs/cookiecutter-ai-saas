import crypto from "node:crypto";
import type { EmailConfig } from "next-auth/providers/email";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * How many sign-in emails may go out in each window.
 *
 * - perAddress: 3. Someone signing in asks once, and maybe again when the
 *   first is slow or lands in spam; a third covers a typo'd retry. More than
 *   that to one inbox in 15 minutes is somebody else's script, not the owner.
 * - perIp: 15. Wider than one person's needs, so an office or household
 *   behind one address can sign in several people, but a script mailing many
 *   addresses from one client stops after 15. An IPv6 client counts by its
 *   /64 (see clientKey in lib/rate-limit.ts). (Caddy's strict limit on
 *   /api/auth/signin/* bounds bursts per minute; this bounds the quarter
 *   hour.)
 *
 * A request over either limit sends nothing and still lands on the "check
 * your email" page, so it says nothing about whether the address has an
 * account. The cost: anyone can spend an address's three in a window and
 * hold its owner's next link back for up to 15 minutes; OAuth still works.
 */
export const signInLinkLimits = {
  perAddress: 3,
  perIp: 15,
  windowSec: 15 * 60,
};

type SendVerificationRequest = EmailConfig["sendVerificationRequest"];

/** Whether a sign-in link to `email`, asked for by `client`, may be sent. */
async function maySend(email: string, client: string): Promise<boolean> {
  const { perAddress, perIp, windowSec } = signInLinkLimits;
  // The client first: once it is over its limit, its requests stop counting
  // against the addresses it names.
  if (!(await rateLimit(`sign-in-link:ip:${client}`, perIp, windowSec)).success) return false;
  // Hashed, so Redis holds no address in the clear.
  const address = crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  return (await rateLimit(`sign-in-link:email:${address}`, perAddress, windowSec)).success;
}

/**
 * `provider`, sending its sign-in emails only within signInLinkLimits.
 *
 * Auth.js calls sendVerificationRequest after the signIn callback has let the
 * request through, so only requests that would send an email count. Skipping
 * the send, rather than throwing, keeps Auth.js's usual redirect to the
 * "check your email" page. The sender is whichever Auth.js would have called:
 * one given in the provider's options (the dev-mode logger in
 * lib/auth.config.ts), else the provider's own (Resend's API).
 */
export function limitSignInLinks(provider: EmailConfig): EmailConfig {
  const send = provider.options?.sendVerificationRequest ?? provider.sendVerificationRequest;
  const limited: SendVerificationRequest = async (params) => {
    if (!(await maySend(params.identifier, clientKey(params.request.headers)))) {
      console.warn("Sign-in email not sent: rate limit reached");
      return;
    }
    await send(params);
  };
  // Auth.js merges options over the provider's defaults, so both get it.
  return {
    ...provider,
    sendVerificationRequest: limited,
    options: { ...provider.options, sendVerificationRequest: limited },
  };
}
