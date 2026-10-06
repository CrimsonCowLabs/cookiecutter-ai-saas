import config from "@/config";
import type { PlanTier, PlanConfig } from "@/types/config";

export function getPlanConfig(tier: PlanTier): PlanConfig {
  const plan = config.stripe.plans.find((p) => p.tier === tier);
  if (!plan) throw new Error(`Unknown plan: ${tier}`);
  return plan;
}

export function getPlanLimits(tier: PlanTier) {
  return getPlanConfig(tier).limits;
}

/** A plan's price in its own currency: "$99", "$9.50", "€20". */
export function formatPrice({ price, currency }: Pick<PlanConfig, "price" | "currency">): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
  }).format(price);
}

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
