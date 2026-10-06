import { ConfigProps } from "./types/config";

const config = {
  appName: "__PROJECT_NAME__",
  appDescription: "__PROJECT_DESCRIPTION__",
  domainName: "__DOMAIN_NAME__",
  stripe: {
    plans: [
      {
        tier: "free",
        priceId: "",
        name: "Free",
        description: "Get started for free",
        price: 0,
        currency: "usd",
        interval: "year",
        limits: {
          jobsPerMonth: 100,
          concurrentJobs: 1,
          features: [],
        },
        features: [
          { name: "1 item", included: true },
          { name: "100 API calls/month", included: true },
          { name: "Basic features", included: true },
          { name: "Premium features", included: false },
          { name: "History", included: false },
        ],
      },
      {
        tier: "pro",
        isFeatured: true,
        priceId:
          process.env.NODE_ENV === "production"
            ? "price_REPLACE_WITH_LIVE_PRICE_ID"
            : "price_REPLACE_WITH_TEST_PRICE_ID",
        name: "Pro",
        description: "For power users",
        price: 99,
        currency: "usd",
        interval: "year",
        limits: {
          jobsPerMonth: 5000,
          concurrentJobs: 3,
          features: ["premium", "history"],
        },
        features: [
          { name: "10 items", included: true },
          { name: "5,000 API calls/month", included: true },
          { name: "All basic features", included: true },
          { name: "Premium features", included: true },
          { name: "Full history", included: true },
        ],
      },
      {
        tier: "enterprise",
        priceId:
          process.env.NODE_ENV === "production"
            ? "price_REPLACE_WITH_LIVE_PRICE_ID"
            : "price_REPLACE_WITH_TEST_PRICE_ID",
        name: "Enterprise",
        description: "For growing teams",
        price: 249,
        currency: "usd",
        interval: "year",
        limits: {
          jobsPerMonth: 50000,
          concurrentJobs: 10,
          features: ["premium", "history", "scheduled", "emailNotifications"],
        },
        features: [
          { name: "100 items", included: true },
          { name: "50,000 API calls/month", included: true },
          { name: "All features included", included: true },
          { name: "Scheduled tasks", included: true },
          { name: "Email notifications", included: true },
          { name: "Priority support", included: true },
        ],
      },
    ],
  },
  resend: {
    fromNoReply: "__PROJECT_NAME__ <noreply@__DOMAIN_NAME__>",
    fromAdmin: "__PROJECT_NAME__ <hello@__DOMAIN_NAME__>",
    supportEmail: "support@__DOMAIN_NAME__",
  },
  colors: {
    theme: "__DAISYUI_THEME__",
    main: "__PRIMARY_COLOR__",
  },
  auth: {
    loginUrl: "/sign-in",
    callbackUrl: "/dashboard",
  },
  // Replace every REPLACE_WITH_ value before you launch. See
  // docs/compliance.md, which says what each one is for and where to get it.
  legal: {
    // 13 is the US line (COPPA). Some EU countries set 14, 15 or 16 under the
    // GDPR; raise this if you serve them.
    minimumAge: 13,
    marketingPostalAddress: "REPLACE_WITH_MARKETING_POSTAL_ADDRESS",
    dmcaAgent: {
      name: "REPLACE_WITH_DMCA_AGENT_NAME",
      postalAddress: "REPLACE_WITH_DMCA_AGENT_POSTAL_ADDRESS",
      phone: "REPLACE_WITH_DMCA_AGENT_PHONE",
      email: "REPLACE_WITH_DMCA_AGENT_EMAIL",
    },
    accessibility: {
      contactEmail: "REPLACE_WITH_ACCESSIBILITY_CONTACT_EMAIL",
      reviewDate: "REPLACE_WITH_ACCESSIBILITY_REVIEW_DATE",
    },
    consentTextVersion: "REPLACE_WITH_CONSENT_TEXT_VERSION",
  },
} satisfies ConfigProps;

export default config;
