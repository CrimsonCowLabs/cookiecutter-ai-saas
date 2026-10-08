import Stripe from "stripe";
import type { PlanConfig } from "@/types/config";
import { renewalTerms } from "@/lib/renewal-terms";

let client: Stripe | null = null;

/**
 * Stripe client, constructed on first use.
 *
 * Constructing it at module scope breaks `next build`: collecting page data for
 * the webhook route imports this module, and the Stripe constructor throws when
 * STRIPE_SECRET_KEY is absent — which it is during a build, and in CI.
 */
export function getStripe(): Stripe {
  if (!client) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    client = new Stripe(secretKey, { typescript: true, ...apiBase() });
  }
  return client;
}

/**
 * Where the Stripe API is. STRIPE_API_BASE is unset in production, so
 * Stripe's own applies; the compliance suite points it at a stand-in
 * (tests/compliance/fake-stripe.mjs) to see which Checkout Sessions the app
 * creates.
 */
function apiBase(): Pick<Stripe.StripeConfig, "host" | "port" | "protocol"> {
  const base = process.env.STRIPE_API_BASE;
  if (!base) return {};
  const url = new URL(base);
  return {
    host: url.hostname,
    port: url.port || undefined,
    protocol: url.protocol === "http:" ? "http" : "https",
  };
}

interface CreateCheckoutParams {
  plan: PlanConfig;
  successUrl: string;
  cancelUrl: string;
  // The Terms of Service the customer has to agree to before paying.
  termsUrl: string;
  couponId?: string | null;
  clientReferenceId?: string;
  // Always the user's own customer, never just their email: see
  // lib/checkout.ts, the only caller, on why.
  customerId: string;
}

interface CreateCustomerPortalParams {
  customerId: string;
  returnUrl: string;
}

export const createCheckout = async ({
  customerId,
  clientReferenceId,
  successUrl,
  cancelUrl,
  termsUrl,
  plan,
  couponId,
}: CreateCheckoutParams): Promise<string | null> => {
  try {
    const terms = renewalTerms(plan);
    if (!terms) throw new Error(`${plan.tier} does not renew, so it has no subscription to check out`);

    const stripeSession = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      // Collecting a tax ID for an existing customer saves the business name
      // (and address) entered with it onto that customer, which Stripe
      // requires be allowed explicitly.
      customer_update: { name: "auto", address: "auto" },
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
      client_reference_id: clientReferenceId,
      line_items: [
        {
          price: plan.priceId,
          quantity: 1,
        },
      ],
      discounts: couponId ? [{ coupon: couponId }] : [],
      // California's Automatic Renewal Law: the renewal terms right beside
      // the pay button, word for word what the app showed beside its own
      // subscribe button, and the customer's affirmative consent to them
      // before paying. Stripe records that consent on the session
      // (`consent.terms_of_service`). See docs/compliance.md.
      custom_text: {
        submit: { message: terms },
        terms_of_service_acceptance: {
          message: `I agree to the [Terms of Service](${termsUrl}), including automatic renewal until I cancel.`,
        },
      },
      consent_collection: { terms_of_service: "required" },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return stripeSession.url;
  } catch (e) {
    console.error(e);
    return null;
  }
};

export const createCustomerPortal = async ({
  customerId,
  returnUrl,
}: CreateCustomerPortalParams): Promise<string> => {
  const portalSession = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return portalSession.url;
};

/**
 * A new Stripe customer for the app's user `userId`. The idempotency key
 * means a retry after a failure to store the id (lib/checkout.ts) gets the
 * same customer back rather than a second one, for as long as Stripe keeps
 * the key (24 hours).
 */
export const createCustomer = async ({
  userId,
  email,
}: {
  userId: string;
  email: string;
}): Promise<string> => {
  const customer = await getStripe().customers.create(
    { email, metadata: { userId } },
    { idempotencyKey: `customer-for-user-${userId}` }
  );
  return customer.id;
};

// Every status but these is a subscription the customer still has, paid up
// or not: the portal, not a second checkout, is where to change it.
const ENDED_SUBSCRIPTION_STATUSES: Stripe.Subscription.Status[] = ["canceled", "incomplete_expired"];

/** Whether `customerId` has a subscription in Stripe that hasn't ended. */
export const hasLiveSubscription = async (customerId: string): Promise<boolean> => {
  const subscriptions = await getStripe().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  return subscriptions.data.some((sub) => !ENDED_SUBSCRIPTION_STATUSES.includes(sub.status));
};

/**
 * Expire every subscription Checkout Session `customerId` still has open, so
 * none of them can be paid any more. Throws if one can't be expired (it was
 * completed in the meantime, say).
 */
export const expireOpenSubscriptionCheckouts = async (customerId: string): Promise<void> => {
  const open = await getStripe().checkout.sessions.list({
    customer: customerId,
    status: "open",
    limit: 100,
  });
  for (const session of open.data) {
    if (session.mode === "subscription") {
      await getStripe().checkout.sessions.expire(session.id);
    }
  }
};

interface CreateOneTimeCheckoutParams {
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  customerId: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
}

/** Call through lib/checkout.ts's oneTimeCheckout, which finds `customerId`. */
export const createOneTimeCheckout = async ({
  priceId,
  quantity,
  successUrl,
  cancelUrl,
  customerId,
  clientReferenceId,
  metadata,
}: CreateOneTimeCheckoutParams): Promise<string | null> => {
  try {
    const stripeSession = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      client_reference_id: clientReferenceId,
      line_items: [{ price: priceId, quantity }],
      // The webhook's checkout.session.completed handler only records and
      // grants a one-time purchase when it sees metadata.type ===
      // "one_time_purchase" (see app/api/webhook/stripe/route.ts). Setting it
      // here, not leaving it to each caller's `metadata`, means this is the
      // only function in the codebase that can create a one-time checkout
      // session, so it's the only place that can forget to mark it as one.
      metadata: { ...metadata, type: "one_time_purchase" },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return stripeSession.url;
  } catch (e) {
    console.error(e);
    return null;
  }
};

export const findCheckoutSession = async (sessionId: string) => {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });
    return session;
  } catch (e) {
    console.error(e);
    return null;
  }
};
