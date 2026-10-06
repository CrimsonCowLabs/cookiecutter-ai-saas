import type { PlanConfig } from "@/types/config";
import { formatPrice } from "@/lib/plans";

/**
 * The automatic-renewal terms for a plan, as one sentence a customer reads
 * right where they subscribe: that it renews automatically until cancelled,
 * what they will be charged and when, and how to cancel online. California's
 * Automatic Renewal Law (Bus. & Prof. Code §17600 et seq.) requires all of
 * that "clearly and conspicuously", next to the subscribe button, before the
 * customer pays; see docs/compliance.md.
 *
 * The same text is shown beside every subscribe button
 * (components/billing/renewal-terms.tsx) and beside the pay button in Stripe
 * Checkout (lib/stripe.ts), so what a customer agrees to is word for word what
 * they were shown. Stripe allows up to 1,200 characters there.
 *
 * Null for a plan that never renews: a free plan, or one with no interval
 * (a one-time purchase).
 */
export function renewalTerms(
  plan: Pick<PlanConfig, "name" | "price" | "currency"> & { interval?: PlanConfig["interval"] }
): string | null {
  if (plan.price <= 0 || !plan.interval) return null;
  const price = formatPrice(plan);
  return (
    `${plan.name} renews automatically every ${plan.interval} at ${price} until you cancel. ` +
    `You will be charged ${price} when you subscribe and again on the same date each ${plan.interval}. ` +
    `Cancel anytime online in Settings, under Manage billing; ` +
    `you keep access until the end of the ${plan.interval} you have paid for.`
  );
}
