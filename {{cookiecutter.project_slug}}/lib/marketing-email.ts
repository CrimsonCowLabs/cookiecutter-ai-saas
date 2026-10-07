import { Resend } from "resend";
import config from "@/config";
import { isSuppressed, unsubscribeEndpointUrl, unsubscribePageUrl } from "@/lib/unsubscribe";

/**
 * The only way this app sends commercial email: newsletters, announcements,
 * offers, anything whose main purpose is to promote. CAN-SPAM applies to
 * every such email and fines each one that breaks it (see
 * docs/compliance.md, "Marketing email"), so the rules are kept here, once,
 * rather than at every call site:
 *
 * 1. Nothing is sent while config.legal.marketingPostalAddress is still a
 *    placeholder: every marketing email must carry a valid postal address.
 * 2. Addresses that opted out (lib/unsubscribe.ts) are skipped.
 * 3. A footer with the unsubscribe link and the postal address is added to
 *    the body.
 * 4. List-Unsubscribe (a URL and a mailto) and List-Unsubscribe-Post
 *    (RFC 8058 one-click) headers are set, so mail clients show their own
 *    unsubscribe button.
 * 5. It is sent through Resend.
 *
 * Transactional email (sign-in links, contact form replies, the subscription
 * acknowledgment) does not come through here, and must not carry marketing.
 */

export interface MarketingEmail {
  to: string;
  subject: string;
  /** Who the email is from, as the recipient will see it: "Acme Weekly". */
  senderName: string;
  /** Plain text. The footer is added after it. */
  body: string;
}

/**
 * - "sent": Resend accepted it.
 * - "suppressed": the recipient opted out; nothing was sent.
 * - "failed": Resend refused it or could not be reached (logged here).
 */
export type MarketingEmailResult = "sent" | "suppressed" | "failed";

const PLACEHOLDER = /REPLACE_WITH_/;

/** The address marketing email is sent from, with `senderName` shown. */
function from(senderName: string): string {
  const address = config.resend.fromAdmin.match(/<([^>]+)>/)?.[1] ?? config.resend.fromAdmin;
  return `${senderName.replace(/["<>]/g, "")} <${address}>`;
}

/** `body` with the footer every marketing email ends with. */
export function withFooter(body: string, to: string): string {
  return [
    body.trimEnd(),
    "",
    "--",
    `Unsubscribe from ${config.appName} marketing email: ${unsubscribePageUrl(to)}`,
    `${config.appName}, ${config.legal.marketingPostalAddress}`,
  ].join("\n");
}

/**
 * Send `email` as marketing email, or skip it for a recipient who opted out.
 *
 * Throws, sending nothing, when the project isn't set up to send marketing
 * email legally: the postal address is a placeholder, or Resend isn't
 * configured.
 */
export async function sendMarketingEmail({ to, subject, senderName, body }: MarketingEmail): Promise<MarketingEmailResult> {
  if (PLACEHOLDER.test(config.legal.marketingPostalAddress)) {
    throw new Error(
      "config.legal.marketingPostalAddress is still a placeholder; marketing email must carry a valid postal address (see docs/compliance.md)"
    );
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set; marketing email cannot be sent");

  if (await isSuppressed(to)) return "suppressed";

  try {
    const { error } = await new Resend(apiKey).emails.send({
      from: from(senderName),
      to,
      subject,
      text: withFooter(body, to),
      headers: {
        "List-Unsubscribe": `<${unsubscribeEndpointUrl(to)}>, <mailto:${config.resend.supportEmail}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (!error) return "sent";
    console.error("Marketing email send failed:", error.message);
  } catch (e) {
    console.error("Marketing email send failed:", e);
  }
  return "failed";
}
