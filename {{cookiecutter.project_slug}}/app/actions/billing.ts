"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createCustomerPortal } from "@/lib/stripe";
import { subscriptionCheckout } from "@/lib/checkout";
import { audit } from "@/lib/audit";
import { getPlanConfig } from "@/lib/plans";
import config from "@/config";
import type { PlanConfig, PlanTier } from "@/types/config";

/**
 * Where to send user `userId` to subscribe to `plan`: a Stripe Checkout that
 * carries the plan's renewal terms (see lib/stripe.ts's createCheckout), or,
 * for a user already subscribed, the billing portal instead (see
 * lib/checkout.ts's subscriptionCheckout, which every subscription checkout
 * goes through).
 */
function checkoutFor(userId: string, plan: PlanConfig): Promise<string | null> {
  return subscriptionCheckout({
    userId,
    plan,
    successUrl: `${process.env.NEXTAUTH_URL}/dashboard?upgraded=true`,
    cancelUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
    termsUrl: `${process.env.NEXTAUTH_URL}/tos`,
    returnUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
  });
}

export async function createCheckoutAction(tier: PlanTier) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const url = await checkoutFor(session.user.id, getPlanConfig(tier));

  if (url) redirect(url);
}

/**
 * Returns checkout URL (or the billing portal's, for a user already
 * subscribed) instead of redirecting.
 * Use this from client components where redirect() doesn't work.
 */
export async function getCheckoutUrl(tier: PlanTier): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  return checkoutFor(session.user.id, getPlanConfig(tier));
}

/**
 * Starts checkout for the plan named by the form's `planId`: the upgrade
 * buttons on the settings page submit it, and so does
 * components/dashboard/resume-pending-plan.tsx for a plan chosen before the
 * visitor signed up (see lib/pending-plan.ts). A plain form action — the same
 * convention this file's other actions, and the sidebar's sign-out button,
 * already use — so redirect() reaches the browser the normal way.
 *
 * Silently does nothing for a missing/unknown tier, a free tier (no priceId
 * to check out), or a tier the user is already on: the dashboard runs this
 * unprompted on every visit while the pending-plan cookie is set, so it must
 * never re-charge someone for a plan they already hold. A user subscribed to
 * another plan goes to the billing portal to change it, like any other
 * subscription checkout (see checkoutFor).
 */
export async function startCheckoutAction(formData: FormData) {
  const planId = formData.get("planId");
  if (typeof planId !== "string" || !planId) return;

  const plan = config.stripe.plans.find((p) => p.tier === planId);
  if (!plan || !plan.priceId) return;

  const session = await auth();
  if (!session?.user?.id) return;

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });
  if (!user || user.plan === plan.tier) return;

  const url = await checkoutFor(user.id, plan);

  if (url) redirect(url);
}

export async function createPortalAction() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!user?.stripeCustomerId) {
    throw new Error("No subscription found");
  }

  await audit({
    userId: session.user.id,
    action: "billing.portal_opened",
    resourceType: "user",
    resourceId: session.user.id,
  });

  const url = await createCustomerPortal({
    customerId: user.stripeCustomerId,
    returnUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
  });

  redirect(url);
}
