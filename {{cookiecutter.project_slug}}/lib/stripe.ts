import Stripe from "stripe";

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
    client = new Stripe(secretKey, { typescript: true });
  }
  return client;
}

interface CreateCheckoutParams {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  couponId?: string | null;
  clientReferenceId?: string;
  user?: {
    customerId?: string;
    email?: string;
  };
}

interface CreateCustomerPortalParams {
  customerId: string;
  returnUrl: string;
}

export const createCheckout = async ({
  user,
  clientReferenceId,
  successUrl,
  cancelUrl,
  priceId,
  couponId,
}: CreateCheckoutParams): Promise<string | null> => {
  try {
    const userParam: {
      customer?: string;
      customer_email?: string;
    } = {};

    if (user?.customerId) {
      userParam.customer = user.customerId;
    } else if (user?.email) {
      userParam.customer_email = user.email;
    }

    const stripeSession = await getStripe().checkout.sessions.create({
      mode: "subscription",
      ...userParam,
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
      client_reference_id: clientReferenceId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      discounts: couponId ? [{ coupon: couponId }] : [],
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

interface CreateOneTimeCheckoutParams {
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  customerId: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
}

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
