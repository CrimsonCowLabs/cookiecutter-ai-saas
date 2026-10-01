import { NextResponse, NextRequest } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, subscriptions, purchases } from "@/lib/db/schema";
import { getStripe, findCheckoutSession } from "@/lib/stripe";
import { audit } from "@/lib/audit";
import config from "@/config";

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
 * present: a webhook *event's* payload shape is pinned to whatever API
 * version the webhook endpoint itself was configured with in the Stripe
 * Dashboard, independent of which stripe-node version this app's code calls
 * the API with. An endpoint still pinned to a pre-basil version delivers
 * events whose subscription items exist but lack these per-item fields, and
 * `item.current_period_start * 1000` on an undefined field is `NaN` — this
 * falls back the same way a genuinely missing item does, rather than writing
 * an Invalid Date.
 */
function getSubscriptionPeriod(sub: Stripe.Subscription): {
  start: Date;
  end: Date;
} {
  const item = sub.items.data[0];
  if (!item?.current_period_start || !item?.current_period_end) {
    // Falling back silently would let billing-period drift accumulate
    // unnoticed (see the comment above), so this is loud even though it's
    // non-fatal: the webhook still returns 200 rather than failing the event.
    console.error(
      `[Webhook] subscription ${sub.id} has no usable per-item billing period` +
        " (missing item, or the webhook endpoint is still pinned to a" +
        ' pre-"basil" Stripe API version); falling back to a guessed period.'
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

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhooks are not configured" },
      { status: 501 }
    );
  }

  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("stripe-signature");

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(body, signature!, webhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Webhook signature verification failed. ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const stripeObject = event.data.object as Stripe.Checkout.Session;

        // Handle one-time purchases
        if (stripeObject.metadata?.type === "one_time_purchase") {
          const userId = stripeObject.client_reference_id;
          if (!userId) break;

          const session = await findCheckoutSession(stripeObject.id);
          const lineItem = session?.line_items?.data[0];
          const quantity = lineItem?.quantity ?? 1;

          // Recording the purchase and granting the credit in one
          // transaction means a failure partway through (a dropped DB
          // connection between the two statements, say) rolls both back
          // rather than leaving a purchase recorded with no credit granted.
          // That matters here specifically because of the idempotency guard
          // below: a purchase row that exists but was never credited would
          // make every future redelivery of this same event a silent no-op
          // forever (onConflictDoNothing would keep skipping it), so the
          // customer would simply never receive what they paid for.
          const purchaseId = await db.transaction(async (tx) => {
            // Unique on stripeCheckoutSessionId: Stripe redelivers webhook
            // events, and this insert is what makes fulfillment idempotent —
            // an empty `inserted` means this checkout session was already
            // recorded, so the credit below must not run twice for it.
            const inserted = await tx
              .insert(purchases)
              .values({
                userId,
                stripeCheckoutSessionId: stripeObject.id,
                stripePriceId: lineItem?.price?.id ?? null,
                quantity,
                amountTotal: stripeObject.amount_total ?? null,
                currency: stripeObject.currency ?? null,
              })
              .onConflictDoNothing({ target: purchases.stripeCheckoutSessionId })
              .returning();

            if (inserted.length === 0) return null;

            // Grant what the purchase promises. "Credits" is deliberately
            // generic — same as lib/plans.ts staying feature-agnostic — this
            // webhook's job is only to make sure a completed payment always
            // shows up as something the app can act on, never silently
            // nothing (see issue #27).
            await tx
              .update(users)
              .set({ credits: sql`${users.credits} + ${quantity}`, updatedAt: new Date() })
              .where(eq(users.id, userId));

            return inserted[0].id;
          });

          if (!purchaseId) break;

          await audit({
            userId,
            action: "billing.one_time_purchase_fulfilled",
            resourceType: "purchase",
            resourceId: purchaseId,
            metadata: { checkoutSessionId: stripeObject.id, quantity },
          });

          break;
        }

        // Handle subscription checkouts
        const session = await findCheckoutSession(stripeObject.id);

        const customerId = session?.customer as string;
        const priceId = session?.line_items?.data[0]?.price?.id;
        const userId = stripeObject.client_reference_id;
        const plan = config.stripe.plans.find((p) => p.priceId === priceId);

        if (!plan) break;

        const customer = (await getStripe().customers.retrieve(
          customerId
        )) as Stripe.Customer;

        let user;

        if (userId) {
          const result = await db
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          user = result[0];
        } else if (customer.email) {
          const result = await db
            .select()
            .from(users)
            .where(eq(users.email, customer.email))
            .limit(1);
          user = result[0];

          if (!user) {
            const inserted = await db
              .insert(users)
              .values({
                email: customer.email,
                name: customer.name || null,
              })
              .returning();
            user = inserted[0];
          }
        } else {
          throw new Error("No user found");
        }

        // Update user plan and Stripe customer ID
        await db
          .update(users)
          .set({
            plan: plan.tier,
            stripeCustomerId: customerId,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        // Create subscription record
        if (stripeObject.subscription) {
          const sub = await getStripe().subscriptions.retrieve(
            stripeObject.subscription as string
          );

          const period = getSubscriptionPeriod(sub);

          await db.insert(subscriptions).values({
            userId: user.id,
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId!,
            plan: plan.tier,
            status: "active",
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
          });
        }

        break;
      }

      case "checkout.session.expired": {
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items?.data[0]?.price?.id;
        const plan = config.stripe.plans.find((p) => p.priceId === priceId);

        if (plan) {
          const period = getSubscriptionPeriod(sub);

          // One transaction: subscriptions.plan is per-subscription history,
          // users.plan is what the rest of the app (settings page,
          // getPlanLimits) actually reads, and a plan change here —
          // upgrading or downgrading through the customer portal — left the
          // latter stale (issue #27). Writing them separately would let a
          // failure between the two statements reintroduce that exact bug
          // intermittently, instead of fixing it.
          await db.transaction(async (tx) => {
            const updated = await tx
              .update(subscriptions)
              .set({
                plan: plan.tier,
                stripePriceId: priceId!,
                status: sub.status === "active" ? "active" : "past_due",
                currentPeriodStart: period.start,
                currentPeriodEnd: period.end,
              })
              .where(eq(subscriptions.stripeSubscriptionId, sub.id))
              .returning();

            const subRecord = updated[0];
            if (subRecord) {
              await tx
                .update(users)
                .set({ plan: plan.tier, updatedAt: new Date() })
                .where(eq(users.id, subRecord.userId));
            }
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;

        await db
          .update(subscriptions)
          .set({ status: "canceled" })
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));

        // Revert user to free plan
        const subRecord = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, sub.id))
          .limit(1);

        if (subRecord[0]) {
          await db
            .update(users)
            .set({ plan: "free", updatedAt: new Date() })
            .where(eq(users.id, subRecord[0].userId));
        }

        break;
      }

      default:
        break;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe error: ", message);
  }

  return NextResponse.json({});
}
