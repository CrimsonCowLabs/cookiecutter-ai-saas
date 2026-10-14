import Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { users, subscriptions, purchases, auditLogs, chargeReversals } from "@/lib/db/schema";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { refreshPlan, type Tx } from "@/lib/subscription-sync";
import { withholds, type ChargeFacts } from "@/lib/revocation-policy";

/** The events that reverse a charge, and what each is audited as. */
const AUDITED_AS = {
  "charge.refunded": "billing.charge_refunded",
  "charge.dispute.created": "billing.dispute_created",
  "charge.dispute.closed": "billing.dispute_closed",
} as const;

type ReversalEvent = Stripe.Event & { type: keyof typeof AUDITED_AS };

type PaidFor = { userId: string; resourceId: string } & (
  | { paidFor: "purchase"; quantity: number }
  | { paidFor: "subscription" }
);

const idOf = (expandable: string | { id: string }) => (typeof expandable === "string" ? expandable : expandable.id);

/** Whether the app has an account for user `id`, or for Stripe customer `customer`. */
async function hasAccount(tx: Tx, { id, customer }: { id?: string | null; customer?: string | null }) {
  if (!id && !customer) return false;
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(id ? eq(users.id, id) : eq(users.stripeCustomerId, customer!))
    .limit(1);
  return Boolean(user);
}

/**
 * Throws, so the event is failed and redelivered: the charge paid for
 * something the app will record but hasn't yet (its checkout's paid event
 * is still being retried, say), and the policy has to apply once it has.
 */
function notRecordedYet(what: string): never {
  throw new Error(`${what} isn't recorded yet; its refund or dispute has to wait for it`);
}

/**
 * What payment intent `paymentIntent` paid for, as the app recorded it: the
 * one-time purchase its Checkout Session made, or the subscription whose
 * invoice it paid. Null for anything the app never will record (a payment it
 * didn't take, or one with no account to fulfil it for).
 */
async function paidFor(tx: Tx, paymentIntent: string): Promise<PaidFor | null> {
  const stripe = getStripe();
  // A subscription's Checkout Session has no payment intent of its own: its
  // invoices do.
  const { data: sessions } = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
  const session = sessions[0];
  if (session) {
    const [purchase] = await tx
      .select({ id: purchases.id, userId: purchases.userId, quantity: purchases.quantity })
      .from(purchases)
      .where(eq(purchases.stripeCheckoutSessionId, session.id));
    if (purchase) {
      return { paidFor: "purchase", userId: purchase.userId, resourceId: purchase.id, quantity: purchase.quantity };
    }
    if (session.metadata?.type === "one_time_purchase" && (await hasAccount(tx, { id: session.client_reference_id }))) {
      notRecordedYet(`one-time purchase ${session.id}`);
    }
    return null;
  }

  const { data: payments } = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntent },
    expand: ["data.invoice"],
    limit: 1,
  });
  const invoice = payments[0]?.invoice;
  if (typeof invoice !== "object" || !("parent" in invoice)) return null;
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  const [record] = await tx
    .select({ id: subscriptions.id, userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, idOf(subscription)));
  if (record) return { paidFor: "subscription", userId: record.userId, resourceId: record.id };
  if (invoice.customer && (await hasAccount(tx, { customer: idOf(invoice.customer) }))) {
    notRecordedYet(`subscription ${idOf(subscription)}`);
  }
  return null;
}

/**
 * What the policy is told of a charge's disputes: the one that withholds
 * most, if it has several. An inquiry closed without becoming a chargeback
 * ("warning_closed"), or one prevented from becoming one ("prevented",
 * usually by a refund, which `refunded` reports), counts as won.
 */
function disputeOf(disputes: Stripe.Dispute[]): ChargeFacts["dispute"] {
  const outcomes = disputes.map(({ status }) =>
    status === "lost" ? "lost" : ["won", "warning_closed", "prevented"].includes(status) ? "won" : "open"
  );
  return (["lost", "open", "won"] as const).find((outcome) => outcomes.includes(outcome)) ?? null;
}

/**
 * Record refund or dispute `event` of Stripe charge `chargeId` against the
 * purchase or subscription it paid for, and apply lib/revocation-policy.ts
 * to it.
 *
 * The charge and its disputes are fetched afresh rather than read off the
 * event, which Stripe may redeliver late or out of order, and the policy's
 * answer is applied as a state, not a step: credits are taken back only
 * when the charge starts to withhold and given back only when it stops. So
 * however often and in whatever order a charge's events arrive, what's
 * applied converges on Stripe's current state. Events of one charge take
 * turns (a transaction-scoped advisory lock, held across the Stripe calls),
 * and each is audited once, by its event id.
 *
 * Throws when Stripe can't be reached, or when what the charge paid for
 * isn't recorded yet, so the event can be failed and redelivered.
 */
export async function reconcileCharge(chargeId: string, event: ReversalEvent) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"charge:" + chargeId}, 0))`);
    const stripe = getStripe();
    const [charge, { data: disputes }] = await Promise.all([
      stripe.charges.retrieve(chargeId),
      stripe.disputes.list({ charge: chargeId, limit: 100 }),
    ]);
    const paymentIntent = charge.payment_intent && idOf(charge.payment_intent);
    const target = paymentIntent ? await paidFor(tx, paymentIntent) : null;
    if (!target) {
      // Nothing the app granted, or ever will, to take back.
      console.error(
        `[Webhook] ${event.type} ${event.id}: charge ${chargeId} paid for no purchase or` +
          " subscription the app recorded; nothing to revoke."
      );
      return;
    }

    const facts: ChargeFacts = {
      paidFor: target.paidFor,
      refunded: charge.refunded ? "full" : charge.amount_refunded > 0 ? "partial" : "none",
      dispute: disputeOf(disputes),
    };
    const withheld = withholds(facts);

    // Locked before the credits are read, and before the upsert, whose
    // foreign-key check share-locks the user's row: a sync of their
    // subscription (lib/subscription-sync.ts) then takes turns with this one.
    const [user] = await tx
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.id, target.userId))
      .for("update");
    const [recorded] = await tx
      .select({ withholds: chargeReversals.withholds, creditsWithheld: chargeReversals.creditsWithheld })
      .from(chargeReversals)
      .where(eq(chargeReversals.stripeChargeId, chargeId));
    const wasWithheld = recorded?.withholds ?? false;

    let creditsWithheld = recorded?.creditsWithheld ?? 0;
    if (target.paidFor === "purchase" && withheld !== wasWithheld) {
      // Taken back: the purchase's credits, but never more than the user has
      // left, since those already spent are gone. Given back: what was taken.
      const credits = withheld
        ? user.credits - Math.min(user.credits, target.quantity)
        : user.credits + creditsWithheld;
      creditsWithheld = withheld ? user.credits - credits : 0;
      await tx.update(users).set({ credits, updatedAt: new Date() }).where(eq(users.id, target.userId));
    }

    const state = { withholds: withheld, creditsWithheld, updatedAt: new Date() };
    await tx
      .insert(chargeReversals)
      .values({
        stripeChargeId: chargeId,
        userId: target.userId,
        purchaseId: target.paidFor === "purchase" ? target.resourceId : null,
        subscriptionId: target.paidFor === "subscription" ? target.resourceId : null,
        ...state,
      })
      .onConflictDoUpdate({ target: chargeReversals.stripeChargeId, set: state });
    if (target.paidFor === "subscription") await refreshPlan(tx, target.userId);

    // In this transaction, under the charge's lock, so two deliveries of the
    // event at once still record it once.
    const action = AUDITED_AS[event.type];
    const [audited] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), sql`${auditLogs.metadata}->>'eventId' = ${event.id}`))
      .limit(1);
    if (audited) return;
    await tx.insert(auditLogs).values({
      userId: target.userId,
      action,
      resourceType: target.paidFor,
      resourceId: target.resourceId,
      metadata: {
        eventId: event.id,
        chargeId,
        paymentIntent,
        amount: charge.amount,
        amountRefunded: charge.amount_refunded,
        ...facts,
        withholds: withheld,
        creditsWithheld,
      },
    });
  });
}
