import Link from "next/link";
import { Main } from "@/components/ui/skip-link";

export default function TermsOfServicePage() {
  return (
    <Main className="min-h-screen bg-base-100">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content">
          <span>&larr;</span>
          Back to home
        </Link>

        <div className="space-y-3">
          <p className="text-sm font-medium text-primary">__PROJECT_NAME__ Terms of Service</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Terms of Service
          </h1>
          <p className="text-sm text-base-content/60">
            Last updated: {new Date().toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>

        <div className="mt-10 space-y-8 text-base-content/80">
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              1. Scope of Service
            </h2>
            <p>
              __PROJECT_NAME__ provides AI-powered data processing and automation
              tools. By using the service, you agree to these terms and conditions.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              2. User Responsibilities
            </h2>
            <p>
              You are responsible for the data you submit and ensuring that your
              use of the service complies with applicable laws and regulations.
              You must not use the service for illegal, harmful, or abusive purposes.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              3. Data Processing
            </h2>
            <p>
              We process your submitted data using AI models to generate results.
              Results are provided for informational purposes and you are
              responsible for reviewing and acting on them.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              4. Service Limits
            </h2>
            <p>
              Usage may be rate-limited or restricted based on your plan. We may
              modify or suspend the service to maintain platform stability.
            </p>
          </section>

          {/* cc:begin stripe */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              5. Payment and Automatic Renewal
            </h2>
            <p>
              A paid plan is a subscription that renews automatically at the
              end of each billing period, monthly or yearly as shown for your
              plan, at the price shown next to its subscribe button, until you
              cancel. We charge the payment method you gave at checkout when
              you subscribe and again at the start of each new period. You
              agree to these renewal terms when you subscribe.
            </p>
            <p>
              You can cancel online at any time: in Settings, choose Manage
              billing to open the billing portal. Cancelling stops the next
              renewal; you keep your plan until the end of the period you have
              paid for. Payments are not refunded for the rest of a period you
              cancel in, except where the law requires it. If we change a
              plan&apos;s price, we will tell you before the change applies to
              your next renewal, so you can cancel first. See{" "}
              <Link href="/legal/subscriptions" className="link link-primary">
                Subscriptions &amp; renewal
              </Link>{" "}
              for the terms of each plan.
            </p>
          </section>
          {/* cc:end stripe */}
          {/* cc:begin no-stripe */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              5. Fees
            </h2>
            <p>
              Prices for paid plans are shown on our website. We will tell you
              what a plan costs, and ask for your agreement, before charging
              you anything.
            </p>
          </section>
          {/* cc:end no-stripe */}

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              6. Disclaimer
            </h2>
            <p>
              __PROJECT_NAME__ provides the service &quot;as is&quot; without warranties of
              any kind. AI-generated results may not be 100% accurate and should
              be reviewed before acting upon them.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              7. Limitation of Liability
            </h2>
            <p>
              To the maximum extent permitted by law, we are not liable for any
              indirect, incidental, special, consequential, or punitive damages
              resulting from your use of the service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              8. Changes
            </h2>
            <p>
              We may update these Terms from time to time. Continued use of the
              service after updates constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              9. Contact
            </h2>
            <p>
              If you have questions about these Terms, contact{" "}
              <a
                href="mailto:__AUTHOR_EMAIL__"
                className="link link-primary"
              >
                __AUTHOR_EMAIL__
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </Main>
  );
}
