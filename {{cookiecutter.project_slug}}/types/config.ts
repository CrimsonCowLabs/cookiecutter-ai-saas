// Any DaisyUI theme name (the one chosen as daisyui_theme at generation time).
export type Theme = string;

export type PlanTier = "free" | "pro" | "enterprise";

export interface PlanConfig {
  tier: PlanTier;
  isFeatured?: boolean;
  priceId: string;
  name: string;
  description?: string;
  price: number;
  priceAnchor?: number;
  interval: "month" | "year";
  limits: {
    jobsPerMonth: number;
    concurrentJobs: number;
    features: string[];
  };
  features: {
    name: string;
    included: boolean;
  }[];
}

// The operator's legal details, for the /legal pages and the compliance
// features that need them as those are added. Each string ships as a "REPLACE_WITH_..."
// placeholder; see docs/compliance.md for what each one is for.
export interface LegalConfig {
  // Visitors younger than this cannot create an account.
  minimumAge: number;
  // The physical postal address every marketing email has to carry
  // (CAN-SPAM). A PO box or a registered mail-receiving service is fine.
  marketingPostalAddress: string;
  // The designated agent for copyright (DMCA) notices, exactly as registered
  // with the US Copyright Office.
  dmcaAgent: {
    name: string;
    postalAddress: string;
    phone: string;
    email: string;
  };
  accessibility: {
    // Where visitors report an accessibility problem.
    contactEmail: string;
    // When the accessibility statement was last reviewed, as YYYY-MM-DD.
    reviewDate: string;
  };
  // The version of the consent text visitors agree to. Changing it makes
  // every existing consent invalid, so everyone is asked again.
  consentTextVersion: string;
}

export interface ConfigProps {
  appName: string;
  appDescription: string;
  domainName: string;
  stripe: {
    plans: PlanConfig[];
  };
  resend: {
    fromNoReply: string;
    fromAdmin: string;
    supportEmail: string;
  };
  colors: {
    theme: Theme;
    main: string;
  };
  auth: {
    loginUrl: string;
    callbackUrl: string;
  };
  legal: LegalConfig;
}
