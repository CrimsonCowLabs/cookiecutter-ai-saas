import type { Metadata } from "next";
import Link from "next/link";
import config from "@/config";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { renewalTerms } from "@/lib/renewal-terms";

export const metadata: Metadata = {
  title: "Subscriptions & renewal | __PROJECT_NAME__",
};

const paidPlans = config.stripe.plans.flatMap((plan) => {
  const terms = renewalTerms(plan);
  return terms ? [{ plan, terms }] : [];
});

/**
 * How paid plans renew, how to cancel and what is refunded. Linked from the
 * Terms of Service and next to the subscribe buttons. The renewal terms are
 * the ones shown beside each button and in Stripe Checkout
 * (lib/renewal-terms.ts).
 */
export default function SubscriptionsPage() {
  return (
    <LegalPage
      title="Subscriptions & renewal"
      intro="How paid plans on __PROJECT_NAME__ renew, how to cancel, and what is refunded."
    >
      <LegalSection title="The risk">
        <p>
          A subscription that renews on its own keeps charging a customer who
          has forgotten about it. California&apos;s Automatic Renewal Law
          (Business and Professions Code sections 17600 to 17606) requires a
          business to show the renewal terms clearly next to the subscribe
          button, to get the customer&apos;s express agreement to them before
          charging, and to let them cancel online. Anything sent without that
          agreement counts as an unconditional gift. Other US states have
          similar laws, and the federal Restore Online Shoppers&apos;
          Confidence Act (ROSCA) sets the same basic rules for online sales.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">Paid plans renew automatically.</strong>{" "}
          A subscription renews at the end of each billing period, and you are
          charged again, until you cancel. The terms of each plan are shown
          right next to its subscribe button, and again next to the pay button
          when you check out:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          {paidPlans.map(({ plan, terms }) => (
            <li key={plan.tier}>{terms}</li>
          ))}
        </ul>
        <p>
          <strong className="text-base-content">You agree before you pay.</strong>{" "}
          Payments are taken by Stripe Checkout, which will not take your
          payment until you tick the box agreeing to our{" "}
          <Link href="/tos" className="link link-primary">
            Terms of Service
          </Link>
          , including automatic renewal. Stripe sends a receipt by email.
        </p>
        <p>
          <strong className="text-base-content">Cancel online, anytime.</strong>{" "}
          Open Settings in your dashboard and choose Manage billing. That opens
          the billing portal, where you can cancel in a few clicks, with no
          need to call or write to us. Cancelling stops the next renewal; you
          keep your plan until the end of the period you have already paid
          for, and then move to the free plan.
        </p>
        <p>
          <strong className="text-base-content">Refunds.</strong>{" "}
          A payment is not refunded for the part of a billing period that is
          left when you cancel, except where the law requires it. If you
          believe you were charged by mistake, email{" "}
          <a href="mailto:__AUTHOR_EMAIL__" className="link link-primary">
            __AUTHOR_EMAIL__
          </a>{" "}
          and we will look into it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
