/**
 * What a refund or a dispute takes away: this project's revocation policy.
 * Edit `withholds` to change it; it is the only place that decides.
 *
 * The Stripe webhook calls it for every charge.refunded,
 * charge.dispute.created and charge.dispute.closed event, with the charge as
 * Stripe has it at that moment, and applies the answer to what the charge
 * paid for (lib/charge-reversal.ts):
 *
 *   - a one-time purchase: while it withholds, the purchase's credits are
 *     taken back (no more than the user has left); once it stops, those
 *     credits are given back;
 *   - a subscription: while any of its charges withholds, it grants nothing,
 *     whatever Stripe says of it; once none does, its plan comes back.
 *
 * Every event is recorded in the audit log whatever this decides. Since
 * events arrive late and out of order, decide from the facts given, never
 * from which event arrived: they are the charge's state, not the event's.
 *
 * The template's default (issue #76): a fully refunded purchase withholds
 * its credits; a partial refund, or a refunded subscription invoice, takes
 * nothing (cancelling the subscription is what ends its plan); a dispute
 * withholds what the charge paid for until it is won, and for good if it is
 * lost.
 */
export interface ChargeFacts {
  /** What the charge paid for. */
  paidFor: "purchase" | "subscription";
  /** How much of the charge has been refunded: none, some, or all of it. */
  refunded: "none" | "partial" | "full";
  /**
   * Its dispute, if it has one: "open" while it is being decided (an
   * inquiry, too, which may yet become a chargeback), "won" once decided in
   * your favour (or an inquiry closed without one), "lost" once the money is
   * gone for good.
   */
  dispute: "open" | "won" | "lost" | null;
}

/** Whether a charge with these `facts` withholds what it paid for. */
export function withholds({ paidFor, refunded, dispute }: ChargeFacts): boolean {
  if (dispute === "open" || dispute === "lost") return true;
  return paidFor === "purchase" && refunded === "full";
}
