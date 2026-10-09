import { NextResponse, NextRequest } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, subscriptions, purchases, auditLogs } from "@/lib/db/schema";
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

// What a checkout's payment_status is once its money has arrived, or when
// it needs none (a free trial, a 100% discount).
const PAID: Stripe.Checkout.Session.PaymentStatus[] = ["paid", "no_payment_required"];

function isOneTimePurchase(session: Stripe.Checkout.Session) {
  return session.metadata?.type === "one_time_purchase";
}

/** The id of checkout `session`'s Stripe customer, if it has one. */
function customerOf(session: Stripe.Checkout.Session): string | null {
  return typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
}

type User = typeof users.$inferSelect;

/**
 * The account checkout `session` is for: the one its client_reference_id
 * names, which the app's own checkouts carry, else, for a subscription (a
 * Stripe Payment Link, say), the one with its customer's email. Only ever an
 * existing account: see logUnfulfilled.
 */
async function checkoutUser(session: Stripe.Checkout.Session): Promise<User | null> {
  const userId = session.client_reference_id;
  if (userId) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return user ?? null;
  }
  const customerId = customerOf(session);
  if (isOneTimePurchase(session) || !customerId) return null;
  const customer = (await getStripe().customers.retrieve(customerId)) as Stripe.Customer;
  if (!customer.email) return null;
  const [user] = await db.select().from(users).where(eq(users.email, customer.email)).limit(1);
  return user ?? null;
}

/** Record paid one-time purchase `session` for `userId` and grant its credits, once. */
async function fulfilOneTimePurchase(session: Stripe.Checkout.Session, userId: string) {
  const retrieved = await findCheckoutSession(session.id);
  const lineItem = retrieved?.line_items?.data[0];
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
    // events, and this insert is what makes fulfilment idempotent —
    // an empty `inserted` means this checkout session was already
    // recorded, so the credit below must not run twice for it.
    const inserted = await tx
      .insert(purchases)
      .values({
        userId,
        stripeCheckoutSessionId: session.id,
        stripePriceId: lineItem?.price?.id ?? null,
        quantity,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
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

  if (!purchaseId) return;

  await audit({
    userId,
    action: "billing.one_time_purchase_fulfilled",
    resourceType: "purchase",
    resourceId: purchaseId,
    metadata: { checkoutSessionId: session.id, quantity },
  });
}

/**
 * Record paid subscription checkout `session`'s subscription for `user`,
 * grant its plan and acknowledge it. Resolves to "acknowledgment_failed" when
 * the acknowledgment couldn't be sent, so the event can be failed and
 * redelivered.
 */
async function fulfilSubscription(
  session: Stripe.Checkout.Session,
  user: User
): Promise<"done" | "acknowledgment_failed"> {
  // Their Stripe customer is the one the app created before checkout
  // (lib/checkout.ts), and stays that one: the customer here is only stored
  // for a user who had none, as after a Payment Link checkout.
  const customerId = customerOf(session);
  if (!customerId) return "done";
  if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
    logSecondCustomer(session, user.id, user.stripeCustomerId, customerId);
  }
  await db
    .update(users)
    .set({
      stripeCustomerId: sql`coalesce(${users.stripeCustomerId}, ${customerId})`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  if (!session.subscription) return "done";
  const subscriptionId = session.subscription as string;
  // Records the subscription, and grants the plan, as Stripe has
  // them now rather than as they were at checkout: this event may be
  // a redelivery arriving after the subscription changed or ended.
  const synced = await syncSubscription(subscriptionId, { userId: user.id });
  const plan = synced && config.stripe.plans.find((p) => p.tier === synced.tier);
  // Nothing to acknowledge for a subscription that has already ended
  // (cancelled before this event arrived) or never started.
  if (!plan || !synced.entitles) return "done";

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
    if (sent === "failed") return "acknowledgment_failed";
    if (sent === "sent") {
      await db
        .update(subscriptions)
        .set({ acknowledgedAt: new Date() })
        .where(eq(subscriptions.id, record.id));
    }
  }
  return "done";
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
      // A checkout paid by a delayed method (a bank debit such as ACH or
      // SEPA) completes unpaid; the money arrives, or fails to, days later.
      // Access is granted only once it has: a card checkout completes
      // already paid, a debit's arrives as async_payment_succeeded. Either
      // way, fulfilling it again on a redelivery grants nothing more.
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (!PAID.includes(session.payment_status)) break;

        const user = await checkoutUser(session);
        if (!user) {
          logUnfulfilled(session, customerOf(session));
          break;
        }

        if (isOneTimePurchase(session)) {
          await fulfilOneTimePurchase(session, user.id);
          break;
        }
        if ((await fulfilSubscription(session, user)) === "acknowledgment_failed") {
          // A 5xx makes Stripe redeliver the event, and the redelivery sends
          // it. Everything before it is safe to run again.
          return NextResponse.json(
            { error: "Subscription acknowledgment send failed" },
            { status: 500 }
          );
        }
        break;
      }

      // The debit failed: nothing was granted, so nothing is taken away. A
      // subscription it was for grants nothing until its first invoice is
      // paid some other way (see lib/subscription-sync.ts). Audited once per
      // checkout, however often Stripe redelivers the event.
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const [audited] = await db
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.action, "billing.async_payment_failed"),
              sql`${auditLogs.metadata}->>'checkoutSessionId' = ${session.id}`
            )
          )
          .limit(1);
        if (audited) break;
        const user = await checkoutUser(session);
        await audit({
          userId: user?.id ?? null,
          action: "billing.async_payment_failed",
          resourceType: "checkout_session",
          metadata: {
            checkoutSessionId: session.id,
            mode: session.mode,
            customerId: customerOf(session),
          },
        });
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
