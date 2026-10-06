import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, subscriptions } from "@/lib/db/schema";
import { formatPrice, getPlanConfig } from "@/lib/plans";
import { createPortalAction, startCheckoutAction } from "@/app/actions/billing";
import { WithRenewalTerms } from "@/components/billing/renewal-terms";
import config from "@/config";
import Link from "next/link";

export default async function SettingsPage() {
  const formatDate = (date: Date) =>
    new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);

  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });
  if (!user) return null;

  const currentPlan = getPlanConfig(user.plan);
  const limits = currentPlan.limits;

  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, session.user.id),
  });

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* Account */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Account</h2>
        <div className="bg-base-200 rounded-lg p-5 space-y-3">
          <div className="flex justify-between gap-2">
            <span className="text-sm text-base-content/60 shrink-0">Email</span>
            <span className="text-sm truncate min-w-0">{user.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-base-content/60">Member since</span>
            <span className="text-sm">
              {formatDate(user.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Plan & billing */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Plan & Billing</h2>
        <div className="bg-base-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold capitalize">{user.plan} plan</p>
              <p className="text-sm text-base-content/60">
                {user.plan === "free"
                  ? "Free forever"
                  : `${formatPrice(currentPlan)} a ${currentPlan.interval}, renews automatically`}
              </p>
            </div>
            {user.plan === "free" ? (
              <a href="#upgrade" className="btn btn-primary">
                Upgrade
              </a>
            ) : (
              <form action={createPortalAction}>
                <button type="submit" className="btn btn-outline">
                  Manage billing
                </button>
              </form>
            )}
          </div>

          <div className="divider my-0" />

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-base-content/60">Jobs per month</p>
              <p className="font-medium">{limits.jobsPerMonth}</p>
            </div>
            <div>
              <p className="text-base-content/60">Concurrent jobs</p>
              <p className="font-medium">{limits.concurrentJobs}</p>
            </div>
            <div className="col-span-2">
              <p className="text-base-content/60">Included features</p>
              <p className="font-medium">
                {limits.features.length > 0
                  ? limits.features.join(", ")
                  : "Core features"}
              </p>
            </div>
          </div>

          {subscription && (
            <>
              <div className="divider my-0" />
              <div className="text-sm text-base-content/60">
                <p>
                  Status:{" "}
                  <span className="capitalize">{subscription.status}</span>
                </p>
                <p>
                  Current period ends{" "}
                  {formatDate(subscription.currentPeriodEnd)}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Plan comparison (for free users) */}
      {user.plan === "free" && (
        <section id="upgrade" aria-labelledby="upgrade-heading" className="space-y-3 scroll-mt-6">
          <h2 id="upgrade-heading" className="text-lg font-semibold">Upgrade</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {config.stripe.plans
              .filter((p) => p.tier !== "free")
              .map((plan) => (
                <div
                  key={plan.tier}
                  className={`bg-base-200 rounded-lg p-5 space-y-3 ${
                    plan.isFeatured ? "ring-2 ring-primary" : ""
                  }`}
                >
                  <div>
                    <h3 className="font-semibold">{plan.name}</h3>
                    <p className="text-sm text-base-content/60">
                      {plan.description}
                    </p>
                    <p className="text-2xl font-bold mt-2">
                      {formatPrice(plan)}
                      <span className="text-sm font-normal text-base-content/60">
                        /{plan.interval}
                      </span>
                    </p>
                  </div>
                  <ul className="space-y-1">
                    {plan.features.map((f) => (
                      <li
                        key={f.name}
                        className={`text-sm flex items-center gap-2 ${
                          f.included ? "" : "text-base-content/70"
                        }`}
                      >
                        <span aria-hidden="true">{f.included ? "\u2713" : "\u2014"}</span>
                        <span className="sr-only">{f.included ? "Included:" : "Not included:"}</span>
                        {f.name}
                      </li>
                    ))}
                  </ul>
                  <form action={startCheckoutAction}>
                    <input type="hidden" name="planId" value={plan.tier} />
                    <WithRenewalTerms plan={plan}>
                      {(describedBy) => (
                        <button
                          type="submit"
                          aria-describedby={describedBy}
                          className="btn btn-primary w-full"
                        >
                          Upgrade to {plan.name}
                        </button>
                      )}
                    </WithRenewalTerms>
                  </form>
                </div>
              ))}
          </div>
          <p className="text-sm text-base-content/70">
            <Link href="/legal/subscriptions" className="link link-primary">
              How renewal, cancellation and refunds work
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}
