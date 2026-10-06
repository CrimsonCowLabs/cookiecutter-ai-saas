import { Resend } from "resend";
import config from "@/config";
import type { PlanConfig } from "@/types/config";
import { renewalTerms } from "@/lib/renewal-terms";

/**
 * The acknowledgment a new subscriber is emailed: the renewal terms they
 * agreed to, word for word as shown beside the subscribe button and in Stripe
 * Checkout (lib/renewal-terms.ts), and how to cancel. California's Automatic
 * Renewal Law requires it after every subscription; see docs/compliance.md.
 *
 * Null for a plan that never renews, which has nothing to acknowledge.
 */
export function subscriptionAcknowledgment(plan: PlanConfig): { subject: string; text: string } | null {
  const terms = renewalTerms(plan);
  if (!terms) return null;
  const site = process.env.NEXTAUTH_URL || `https://${config.domainName}`;
  return {
    subject: `Your ${config.appName} ${plan.name} subscription`,
    text: [
      `Thank you for subscribing to ${config.appName} ${plan.name}.`,
      "",
      "Your subscription terms",
      terms,
      "",
      "How to cancel",
      `1. Sign in at ${site}/sign-in.`,
      `2. Open Settings (${site}/dashboard/settings) and choose Manage billing.`,
      "3. In the billing portal, cancel your subscription.",
      "You can cancel online like this at any time.",
      "",
      `Renewal, cancellation and refunds: ${site}/legal/subscriptions`,
    ].join("\n"),
  };
}

/**
 * Email `to` the acknowledgment for `plan`, through Resend. Without
 * RESEND_API_KEY nothing is sent; the operator turns on Stripe's own
 * subscription emails instead (docs/compliance.md). A failed send is logged,
 * never thrown: the subscription it acknowledges is already recorded.
 */
export async function sendSubscriptionAcknowledgment({ to, plan }: { to: string; plan: PlanConfig }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const message = subscriptionAcknowledgment(plan);
  if (!apiKey || !message) return;

  try {
    const { error } = await new Resend(apiKey).emails.send({ from: config.resend.fromNoReply, to, ...message });
    if (error) console.error("Subscription acknowledgment send failed:", error.message);
  } catch (e) {
    console.error("Subscription acknowledgment send failed:", e);
  }
}
