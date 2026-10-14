import Stripe from "stripe";
import { and, desc, eq, exists, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, subscriptions, subscriptionStatusEnum, chargeReversals } from "@/lib/db/schema";
import { getStripe } from "@/lib/stripe";
import { audit } from "@/lib/audit";
import { planForPrice } from "@/lib/plans";
import type { PlanTier } from "@/types/config";

type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];

/**
 * The statuses that grant a subscription's tier: paid up, in a trial, or
 * past due while Stripe retries the card. Every other status (unpaid,
 * canceled, incomplete, incomplete_expired, paused) leaves the user on free.
 */
const ENTITLING_STATUSES: readonly SubscriptionStatus[] = ["active", "trialing", "past_due"];

/** Whether a subscription grants its tier: an entitling status, and its first invoice paid. */
function entitles({ status, awaitingFirstPayment }: { status: SubscriptionStatus; awaitingFirstPayment: boolean }) {
  return ENTITLING_STATUSES.includes(status) && !awaitingFirstPayment;
}

const isStatus = (status: string): status is SubscriptionStatus =>
  (subscriptionStatusEnum.enumValues as readonly string[]).includes(status);

/**
 * Stripe moved `current_period_start`/`current_period_end` off the
 * Subscription object itself and onto each subscription item as of the
 * 2025-03-31 "basil" API version (shipped starting in stripe-node v18): a
 * subscription's items can each be on a different billing cycle, so the
 * period is now tracked per item rather than per subscription. Verified
 * against the installed stripe package's own type definitions
 * (node_modules/stripe/cjs/resources/Subscriptions.d.ts no longer declares
 * current_period_start/end on `Subscription`; SubscriptionItems.d.ts does) —
 * this app only ever creates single-item subscriptions (see createCheckout
 * in lib/stripe.ts), so the first item's period stands in for "the"
 * subscription's period.
 *
 * This checks the period fields themselves, not just whether an item is
 * present: a missing field multiplied by 1000 is `NaN`, so this falls back
 * the same way a genuinely missing item does, rather than writing an
 * Invalid Date.
 */
function getSubscriptionPeriod(sub: Stripe.Subscription): {
  start: Date;
  end: Date;
} {
  const item = sub.items.data[0];
  if (!item?.current_period_start || !item?.current_period_end) {
    // Falling back silently would let billing-period drift accumulate
    // unnoticed (see the comment above), so this is loud even though it's
    // non-fatal.
    console.error(
      `[Webhook] subscription ${sub.id} has no usable per-item billing period;` +
        " falling back to a guessed period."
    );
  }
  return {
    start: item?.current_period_start
      ? new Date(item.current_period_start * 1000)
      : new Date(),
    end: item?.current_period_end
      ? new Date(item.current_period_end * 1000)
      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Set user `userId`'s plan, which the rest of the app reads, to what their
 * subscriptions entitle them to: the newest that grants its tier, and none
 * that one of its charges withholds (a disputed one, by default; see
 * lib/revocation-policy.ts). So an event for an old, ended subscription
 * can't take away the plan a newer one grants. Lock the user's row first.
 */
export async function refreshPlan(tx: Tx, userId: string) {
  const owned = await tx
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      awaitingFirstPayment: subscriptions.awaitingFirstPayment,
      withheld: exists(
        tx
          .select({ id: chargeReversals.id })
          .from(chargeReversals)
          .where(and(eq(chargeReversals.subscriptionId, subscriptions.id), eq(chargeReversals.withholds, true)))
      ),
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
  const plan = owned.find((sub) => entitles(sub) && !sub.withheld)?.plan ?? "free";
  await tx.update(users).set({ plan, updatedAt: new Date() }).where(eq(users.id, userId));
}

const customerIdOf = (customer: Stripe.Subscription["customer"]) =>
  typeof customer === "string" ? customer : customer?.id;

/** The user whose Stripe customer is `customer`, if any. */
async function userWithCustomer(
  tx: Tx,
  customer: Stripe.Subscription["customer"]
): Promise<string | undefined> {
  const customerId = customerIdOf(customer);
  if (!customerId) return undefined;
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);
  return user?.id;
}

/**
 * Subscription `sub`, of user `userId`, is on a price no plan in config.ts
 * names: a price changed in Stripe, a legacy one, or the other environment's.
 * No redelivery can fix that, so it is made impossible to miss instead,
 * logged and audited with everything needed to find the customer.
 */
async function reportUnknownPrice(
  sub: Stripe.Subscription,
  userId: string,
  priceId: string | undefined,
  event: Stripe.Event
) {
  const customerId = customerIdOf(sub.customer) ?? null;
  console.error(
    `[Webhook] ${event.type} ${event.id}: subscription ${sub.id} of user ${userId}` +
      ` (customer ${customerId ?? "none"}) is on price ${priceId ?? "none"}, which` +
      " no plan in config.ts names. Add the price to config.ts, or move the" +
      " customer onto a configured one in Stripe."
  );
  await audit({
    userId,
    action: "billing.unknown_price",
    resourceType: "subscription",
    metadata: {
      eventId: event.id,
      eventType: event.type,
      subscriptionId: sub.id,
      customerId,
      priceId: priceId ?? null,
    },
  });
}

/**
 * Record Stripe subscription `stripeSubscriptionId` as Stripe has it now, and
 * set its user's plan to match. Every webhook event about a subscription
 * comes through here, and none of them is trusted for the subscription's
 * state: Stripe redelivers events, hours late and in any order, so the
 * subscription is fetched afresh instead. However often and in whatever
 * order events arrive, what's recorded converges on Stripe's current state.
 *
 * The subscription's user is the one it was recorded for, else `userId` (a
 * paid checkout's), else whoever has its Stripe customer. With none, nothing
 * is recorded: its checkout's paid event will record it.
 *
 * A subscription grants nothing until its first invoice is paid, whatever
 * its status: paid by bank debit (ACH, SEPA), Stripe can count it active
 * while the money is still on its way, and keeps it going after the debit
 * fails, until the invoice is paid some other way or Stripe gives up.
 *
 * Syncs of one subscription take turns (a transaction-scoped advisory lock,
 * held across the Stripe call), so the last to finish fetched last: two
 * deliveries at once can't leave an older state written over a newer one.
 *
 * A subscription on a price config.ts doesn't know (see reportUnknownPrice)
 * keeps the tier it was recorded with, if any; never recorded, it isn't
 * recorded now. Either way, `event` is reported, once the sync has committed:
 * the audit insert takes a connection of its own, which mustn't be waited
 * for while this one holds the lock.
 *
 * Resolves to the subscription's tier and whether it grants it, or null if
 * it wasn't recorded. Throws when Stripe can't be reached, so the event can
 * be failed and redelivered.
 */
export async function syncSubscription(
  stripeSubscriptionId: string,
  { event, userId }: { event: Stripe.Event; userId?: string }
): Promise<{ tier: PlanTier; entitles: boolean } | null> {
  let unknownPrice: Parameters<typeof reportUnknownPrice> | undefined;
  const synced = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"subscription:" + stripeSubscriptionId}, 0))`
    );
    const sub = await getStripe().subscriptions.retrieve(stripeSubscriptionId, {
      expand: ["latest_invoice"],
    });

    const [recorded] = await tx
      .select({ userId: subscriptions.userId, plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, sub.id));

    const ownerId = recorded?.userId ?? userId ?? (await userWithCustomer(tx, sub.customer));
    if (!ownerId) {
      console.error(`[Webhook] subscription ${sub.id} has no account to record it for; not recorded yet.`);
      return null;
    }

    const priceId = sub.items.data[0]?.price?.id;
    const configured = planForPrice(priceId);
    if (!configured) unknownPrice = [sub, ownerId, priceId, event];
    const tier: PlanTier | undefined = configured?.tier ?? recorded?.plan;
    if (!priceId || !tier) return null;
    if (!isStatus(sub.status)) {
      console.error(`[Webhook] subscription ${sub.id} has status ${sub.status}, unknown to the app; not recorded.`);
      return null;
    }

    // Locked before the upsert, whose foreign-key check share-locks the
    // user's row: two of the user's subscriptions syncing at once then take
    // turns, rather than deadlock, and the second sees the first's row when
    // it derives the user's plan below.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");

    const period = getSubscriptionPeriod(sub);
    const invoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    const state = {
      stripePriceId: priceId,
      plan: tier,
      status: sub.status,
      awaitingFirstPayment: invoice?.billing_reason === "subscription_create" && invoice.status !== "paid",
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    };
    await tx
      .insert(subscriptions)
      .values({ userId: ownerId, stripeSubscriptionId: sub.id, ...state })
      .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: state });

    await refreshPlan(tx, ownerId);

    return { tier, entitles: entitles(state) };
  });
  if (unknownPrice) await reportUnknownPrice(...unknownPrice);
  return synced;
}
