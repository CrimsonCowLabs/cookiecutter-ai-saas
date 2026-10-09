import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Enums ───────────────────────────────────────────────

export const planEnum = pgEnum("plan", ["free", "pro", "enterprise"]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Every status Stripe reports a subscription in, stored as itself; which of
// them grant the plan is lib/subscription-sync.ts's call.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "canceled",
  "past_due",
  "trialing",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

// ─── Tables ──────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  stripeCustomerId: text("stripe_customer_id"),
  plan: planEnum("plan").notNull().default("free"),
  // What a one-time purchase grants (see the `purchases` table): a generic
  // unit the app itself decides how to spend, the same way lib/plans.ts
  // keeps plan limits provider-agnostic rather than assuming a specific
  // product.
  credits: integer("credits").notNull().default(0),
  isAdmin: boolean("is_admin").notNull().default(false),
  // When this account's holder passed the age screen (lib/age-check.ts), set
  // as the account is created. Never their date of birth, which is not kept
  // anywhere. Null for accounts created before the age gate existed.
  ageCheckPassedAt: timestamp("age_check_passed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"oauth" | "oidc" | "email">().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => ({
    compoundKey: {
      columns: [account.provider, account.providerAccountId],
      name: "accounts_provider_provider_account_id_pk",
    },
  })
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({
    compoundKey: {
      columns: [vt.identifier, vt.token],
      name: "verification_tokens_identifier_token_pk",
    },
  })
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    type: text("type").notNull(), // e.g. "analysis", "generation", "processing"
    input: jsonb("input"), // Job input parameters
    output: jsonb("output"), // Job result data
    progress: integer("progress").notNull().default(0),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("jobs_user_id_idx").on(table.userId),
    statusIdx: index("jobs_status_idx").on(table.status),
  })
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    progress: integer("progress"),
    message: text("message"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdIdx: index("job_events_job_id_idx").on(table.jobId),
  })
);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Unique, and recorded only by upsert (lib/subscription-sync.ts), so
  // redelivered and concurrent webhook events leave one row per subscription.
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  stripePriceId: text("stripe_price_id").notNull(),
  plan: planEnum("plan").notNull(),
  status: subscriptionStatusEnum("status").notNull(),
  currentPeriodStart: timestamp("current_period_start", {
    mode: "date",
  }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", {
    mode: "date",
  }).notNull(),
  // When the subscription acknowledgment email went out (California's
  // Automatic Renewal Law; lib/subscription-acknowledgment.ts). Null until
  // it has, and for good when no email provider is configured: the webhook
  // sends it on whichever delivery of the event first finds it null.
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

// One-time (mode: "payment") Stripe checkouts, as opposed to the
// subscription lifecycle tracked in `subscriptions`. Recorded by the
// checkout.session.completed webhook handler so a completed payment always
// leaves a durable record, even before anything downstream decides what to
// do with it (see users.credits).
export const purchases = pgTable("purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Unique so a redelivered webhook event (Stripe retries on anything but a
  // 2xx, and can redeliver even after one) can't record — or grant — the
  // same purchase twice.
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull().unique(),
  stripePriceId: text("stripe_price_id"),
  quantity: integer("quantity").notNull().default(1),
  amountTotal: integer("amount_total"),
  currency: text("currency"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const contactSubmissions = pgTable(
  "contact_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    type: text("type").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index("contact_submissions_email_idx").on(table.email),
    typeIdx: index("contact_submissions_type_idx").on(table.type),
  })
);

// cc:begin resend
// Addresses that opted out of marketing email (CAN-SPAM; lib/marketing-email.ts
// checks it before every send, lib/unsubscribe.ts records it). Keyed by the
// normalised address and deliberately not tied to `users`, so an opt-out
// outlives the account's deletion and still holds if the address signs up
// again. Never delete a row to "resubscribe" someone without their new,
// explicit opt-in.
export const emailSuppressions = pgTable("email_suppressions", {
  email: text("email").primaryKey(),
  suppressedAt: timestamp("suppressed_at", { mode: "date" }).notNull().defaultNow(),
  // How the opt-out arrived: "unsubscribe-page" (the confirmation page's
  // button), "one-click" (a mail client's RFC 8058 List-Unsubscribe-Post), or
  // whatever an operator records by hand (an emailed request, say).
  source: text("source").notNull(),
});
// cc:end resend

// ─── Relations ───────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  jobs: many(jobs),
  subscriptions: many(subscriptions),
  purchases: many(purchases),
  auditLogs: many(auditLogs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
  events: many(jobEvents),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, {
    fields: [jobEvents.jobId],
    references: [jobs.id],
  }),
  user: one(users, {
    fields: [jobEvents.userId],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const purchasesRelations = relations(purchases, ({ one }) => ({
  user: one(users, {
    fields: [purchases.userId],
    references: [users.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
  }),
}));
