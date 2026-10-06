import Link from "next/link";
import { Main } from "@/components/ui/skip-link";

export default function PrivacyPolicyPage() {
  return (
    <Main className="min-h-screen bg-base-100">
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm text-base-content/60 hover:text-base-content">
          <span>&larr;</span>
          Back to home
        </Link>

        <div className="space-y-3">
          <p className="text-sm font-medium text-primary">__PROJECT_NAME__ Privacy Policy</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Privacy Policy
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
              1. Overview
            </h2>
            <p>
              This Privacy Policy explains how __PROJECT_NAME__ collects, uses, and
              protects your information when you use our services.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              2. What We Collect
            </h2>
            <p>
              We collect the information you provide, such as your name, email
              address, and the data you submit for processing. We also collect
              technical data required to operate the service and deliver results.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              3. How We Use Your Data
            </h2>
            <p>
              We use your information to operate the service, process jobs,
              deliver results, provide support, and improve product quality.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              4. We Do Not Sell Your Data
            </h2>
            <p>
              We do not sell your personal information or job data to third
              parties.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              5. Data Protection
            </h2>
            <p>
              We implement reasonable security measures to protect your information.
              Your data is encrypted in transit and at rest.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              6. Data Retention
            </h2>
            <p>
              We retain data only as long as needed to provide the service and
              meet legal obligations. You may request deletion of your data at
              any time.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-base-content">
              7. Contact
            </h2>
            <p>
              If you have questions about this Privacy Policy, contact{" "}
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
