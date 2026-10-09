import { NextResponse, NextRequest } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, subscriptions, purchases } from "@/lib/db/schema";
import { getStripe, findCheckoutSession } from "@/lib/stripe";
import { audit } from "@/lib/audit";
import { sendSubscriptionAcknowledgment } from "@/lib/subscription-acknowledgment";
import { syncSubscription } from "@/lib/subscription-sync";
import config from "@/config";

/**
 * A paid checkout with no account to fulfil it for. Accounts are created only
 * by Auth.js, behind the age gate (lib/auth.ts), so the webhook never makes
 * one; the operator reconciles the payment instead (docs/compliance.md,
 * "Children's privacy (COPPA)"). Logged by Stripe ids only, never the email.
 * The event is still answered 200: a redelivery would find no account either.
 */
function logUnfulfilled(session: Stripe.Checkout.Session, customerId?: string | null) {
  console.error(
    `[Webhook] no account for checkout session ${session.id}` +
      ` (customer ${customerId ?? "none"}); not fulfilled. Refund it in Stripe` +
      " or ask the customer to sign up."
  );
}

/**
 * A subscription paid for as a Stripe customer other than the user's own: a
 * checkout the app didn't open (a Payment Link, pricing table or Buy
 * Button), for which Stripe made a customer of its own. The plan is granted,
 * but the billing portal, opened as the user's own customer, won't show
 * that subscription, so it is left for the operator (see docs/compliance.md,
 * "Subscriptions and automatic renewal").
 */
function logSecondCustomer(
  session: Stripe.Checkout.Session,
  userId: string,
  ownCustomerId: string,
  customerId: string
) {
  console.error(
    `[Webhook] checkout session ${session.id} for user ${userId} was paid as` +
      ` Stripe customer ${customerId}, not their own ${ownCustomerId}; the` +
      " billing portal won't show that subscription. Plan granted; see" +
      " docs/compliance.md to resolve it."
  );
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
          const owner = userId
            ? await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
            : [];
          if (!userId || !owner[0]) {
            logUnfulfilled(stripeObject, stripeObject.customer as string | null);
            break;
          }

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

        // Handle subscription checkouts. Which plan, and whether it's still
        // granted, comes from the subscription itself (syncSubscription below).
        const customerId = stripeObject.customer as string;
        const userId = stripeObject.client_reference_id;

        const customer = (await getStripe().customers.retrieve(
          customerId
        )) as Stripe.Customer;

        // By the reference id the app's own checkouts carry, else (a Stripe
        // Payment Link, say) by the customer's email. Either way only an
        // existing account: see logUnfulfilled.
        const result = userId
          ? await db.select().from(users).where(eq(users.id, userId)).limit(1)
          : customer.email
            ? await db.select().from(users).where(eq(users.email, customer.email)).limit(1)
            : [];
        const user = result[0];

        if (!user) {
          logUnfulfilled(stripeObject, customerId);
          break;
        }

        // Their Stripe customer is the one the app created before checkout
        // (lib/checkout.ts), and stays that one: the customer here is only
        // stored for a user who had none, as after a Payment Link checkout.
        if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
          logSecondCustomer(stripeObject, user.id, user.stripeCustomerId, customerId);
        }
        await db
          .update(users)
          .set({
            stripeCustomerId: sql`coalesce(${users.stripeCustomerId}, ${customerId})`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        if (stripeObject.subscription) {
          const subscriptionId = stripeObject.subscription as string;
          // Records the subscription, and grants the plan, as Stripe has
          // them now rather than as they were at checkout: this event may be
          // a redelivery arriving after the subscription changed or ended.
          const synced = await syncSubscription(subscriptionId, { userId: user.id });
          const plan = synced && config.stripe.plans.find((p) => p.tier === synced.tier);
          // Nothing to acknowledge for a subscription that has already ended
          // (cancelled before this event arrived) or never started.
          if (!plan || !synced.entitles) break;

          // California's Automatic Renewal Law: acknowledge the subscription
          // with its terms and how to cancel, on whichever delivery of this
          // event first finds it unacknowledged (a no-op without Resend; see
          // lib/subscription-acknowledgment.ts).
          const [record] = await db
            .select({ id: subscriptions.id, acknowledgedAt: subscriptions.acknowledgedAt })
            .from(subscriptions)
            .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
            .limit(1);
          if (record && !record.acknowledgedAt) {
            const sent = await sendSubscriptionAcknowledgment({
              to: user.email,
              plan,
              subscriptionId,
            });
            if (sent === "failed") {
              // A 5xx makes Stripe redeliver the event, and the redelivery
              // sends it. Everything above is safe to run again.
              return NextResponse.json(
                { error: "Subscription acknowledgment send failed" },
                { status: 500 }
              );
            }
            if (sent === "sent") {
              await db
                .update(subscriptions)
                .set({ acknowledgedAt: new Date() })
                .where(eq(subscriptions.id, record.id));
            }
          }
        }

        break;
      }

      case "checkout.session.expired": {
        break;
      }

      // Whatever changed (plan, status, cancellation), the subscription is
      // synced from Stripe rather than read off the event, which may be
      // stale by the time it arrives.
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub.id);
        break;
      }

      default:
        break;
    }
  } catch (e: unknown) {
    // Stripe unreachable, say, or the database. A 5xx makes Stripe redeliver
    // the event, which every handler above is safe to run again for, rather
    // than leaving what the app records behind Stripe's state.
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("stripe error: ", message);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({});
}
