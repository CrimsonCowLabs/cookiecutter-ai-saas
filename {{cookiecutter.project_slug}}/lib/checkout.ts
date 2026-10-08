import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, subscriptions } from "@/lib/db/schema";
import {
  createCheckout,
  createCustomer,
  createCustomerPortal,
  createOneTimeCheckout,
  expireOpenSubscriptionCheckouts,
  hasLiveSubscription,
} from "@/lib/stripe";
import type { PlanConfig } from "@/types/config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` with `userId`'s Stripe customer, creating and storing it first if
 * the user has none yet, and holding a lock on the user's row throughout.
 *
 * The lock is what keeps a user to one customer and one checkout at a time:
 * two requests at once (a double-submitted form, two tabs) each wait their
 * turn here, so the second finds the customer the first stored, and sees
 * whatever checkout the first opened. It is held across Stripe API calls,
 * which costs one database connection for as long as they take; only writes
 * to this user's row (the webhook's, another checkout) ever wait on it.
 *
 * Resolves to null for an unknown user, and for any Stripe failure (logged).
 * A failure in `fn` still keeps a newly stored customer rather than rolling
 * it back.
 */
async function asCustomer<T>(
  userId: string,
  fn: (customerId: string, tx: Tx) => Promise<T | null>
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email, stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) return null;

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      try {
        customerId = await createCustomer({ userId, email: user.email });
      } catch (e) {
        console.error(e);
        return null;
      }
      await tx
        .update(users)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }

    try {
      return await fn(customerId, tx);
    } catch (e) {
      console.error(e);
      return null;
    }
  });
}

/** Whether `userId` has a subscription, recorded here or in Stripe, that hasn't ended. */
async function hasLiveSubscriptionFor(tx: Tx, userId: string, customerId: string) {
  // The webhook records a subscription only once its checkout completes, and
  // marks it canceled when Stripe deletes it; Stripe is asked as well for one
  // paid for moments ago whose webhook hasn't arrived yet.
  const recorded = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), ne(subscriptions.status, "canceled")))
    .limit(1);
  return recorded.length > 0 || (await hasLiveSubscription(customerId));
}

/**
 * Where to send `userId` to subscribe to `plan`. Every subscription checkout
 * comes through here, so a user has at most one live subscription:
 *
 *   - Already subscribed (any subscription that isn't cancelled): the billing
 *     portal, returning to `returnUrl`, where changing plan, cancelling and
 *     updating the card all happen. Never a second checkout.
 *   - Otherwise: a new Checkout Session as the user's own Stripe customer,
 *     with any subscription checkout they still had open expired first, so
 *     only the newest can be paid.
 *
 * Null when there's nowhere to send them (unknown user, Stripe failed).
 */
export async function subscriptionCheckout({
  userId,
  plan,
  successUrl,
  cancelUrl,
  termsUrl,
  returnUrl,
}: {
  userId: string;
  plan: PlanConfig;
  successUrl: string;
  cancelUrl: string;
  termsUrl: string;
  // Where the billing portal sends them back to.
  returnUrl: string;
}): Promise<string | null> {
  return asCustomer(userId, async (customerId, tx) => {
    if (await hasLiveSubscriptionFor(tx, userId, customerId)) {
      return createCustomerPortal({ customerId, returnUrl });
    }
    await expireOpenSubscriptionCheckouts(customerId);
    return createCheckout({
      plan,
      successUrl,
      cancelUrl,
      termsUrl,
      clientReferenceId: userId,
      customerId,
    });
  });
}

/** A one-time (mode: "payment") checkout for `userId`, as their own Stripe customer. */
export async function oneTimeCheckout({
  userId,
  ...params
}: { userId: string } & Omit<
  Parameters<typeof createOneTimeCheckout>[0],
  "customerId" | "clientReferenceId"
>): Promise<string | null> {
  return asCustomer(userId, (customerId) =>
    createOneTimeCheckout({ ...params, customerId, clientReferenceId: userId })
  );
}
