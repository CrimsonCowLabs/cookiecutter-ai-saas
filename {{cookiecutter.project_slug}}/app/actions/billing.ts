"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createCheckout, createCustomerPortal } from "@/lib/stripe";
import { audit } from "@/lib/audit";
import config from "@/config";

export async function createCheckoutAction(priceId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  const url = await createCheckout({
    priceId,
    successUrl: `${process.env.NEXTAUTH_URL}/dashboard?upgraded=true`,
    cancelUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
    clientReferenceId: session.user.id,
    user: {
      customerId: user?.stripeCustomerId ?? undefined,
      email: session.user.email ?? undefined,
    },
  });

  if (url) redirect(url);
}

/**
 * Returns checkout URL instead of redirecting.
 * Use this from client components where redirect() doesn't work.
 */
export async function getCheckoutUrl(priceId: string): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  return createCheckout({
    priceId,
    successUrl: `${process.env.NEXTAUTH_URL}/dashboard?upgraded=true`,
    cancelUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
    clientReferenceId: session.user.id,
    user: {
      customerId: user?.stripeCustomerId ?? undefined,
      email: session.user.email ?? undefined,
    },
  });
}

/**
 * Resumes checkout for a plan chosen before the visitor signed up (see
 * lib/pending-plan.ts and components/dashboard/resume-pending-plan.tsx,
 * which submits this as a plain form action — the same convention this
 * file's other actions, and the sidebar's sign-out button, already use — so
 * createCheckout's redirect() reaches the browser the normal way.
 *
 * Silently does nothing for a missing/unknown tier, a free tier (no priceId
 * to check out), or a tier the user is already on: this runs unprompted on
 * every dashboard visit while the cookie is set, so it must never re-charge
 * someone for a plan they already hold.
 *
 * Calls createCheckout directly rather than delegating to
 * createCheckoutAction, which would re-fetch the exact same user row this
 * function already has in hand just to check `user.plan`.
 */
export async function resumeCheckoutAction(formData: FormData) {
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

  const url = await createCheckout({
    priceId: plan.priceId,
    successUrl: `${process.env.NEXTAUTH_URL}/dashboard?upgraded=true`,
    cancelUrl: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
    clientReferenceId: session.user.id,
    user: {
      customerId: user.stripeCustomerId ?? undefined,
      email: user.email ?? undefined,
    },
  });

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
