import Link from "next/link";
import config from "@/config";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated={new Date()}>
      <LegalSection title="1. Overview">
        <p>
          This Privacy Policy explains how __PROJECT_NAME__ collects, uses, and
          protects your information when you use our services.
        </p>
      </LegalSection>

      <LegalSection title="2. What We Collect">
        <p>
          We collect the information you provide, such as your name, email
          address, and the data you submit for processing. We also collect
          technical data required to operate the service and deliver results.
        </p>
      </LegalSection>

      <LegalSection title="3. How We Use Your Data">
        <p>
          We use your information to operate the service, process jobs,
          deliver results, provide support, and improve product quality.
        </p>
        {/* cc:begin resend */}
        <p>
          If we send you marketing email, every message has a link to
          unsubscribe, and once you do we stop. Emails that are part of
          using the service, such as sign-in links and billing notices,
          are not marketing. See{" "}
          <Link href="/legal/email-preferences" className="link link-primary">
            Email preferences
          </Link>{" "}
          for which is which.
        </p>
        {/* cc:end resend */}
        {/* cc:begin analytics */}
        <p>
          If you agree to it, we measure which pages are used with
          PostHog, which processes the measurements for us. Nothing is
          measured until you choose &ldquo;Accept&rdquo;, a Global Privacy
          Control signal from your browser counts as a refusal, and you
          can withdraw at any time.
          {config.analytics.sessionReplay &&
            " If you also choose to have your visits recorded, a separate choice, we record the pages you see and how you use them, but never what you type, and never the sign-in pages or your account settings."}{" "}
          See{" "}
          <Link href="/legal/analytics" className="link link-primary">
            Analytics &amp; recording
          </Link>{" "}
          for what is collected and for how long.
        </p>
        {/* cc:end analytics */}
        {/* cc:begin no-analytics */}
        <p>
          We use no analytics and no session recording: nothing is tracked
          about which pages you visit. See{" "}
          <Link href="/legal/analytics" className="link link-primary">
            Analytics &amp; recording
          </Link>
          .
        </p>
        {/* cc:end no-analytics */}
      </LegalSection>

      <LegalSection title="4. We Do Not Sell Your Data">
        <p>
          We do not sell your personal information or job data to third
          parties.
        </p>
      </LegalSection>

      <LegalSection title="5. Data Protection">
        <p>
          We implement reasonable security measures to protect your information.
          Your data is encrypted in transit and at rest.
        </p>
      </LegalSection>

      <LegalSection title="6. Data Retention">
        <p>
          We retain data only as long as needed to provide the service and
          meet legal obligations. You may request deletion of your data at
          any time.
        </p>
      </LegalSection>

      <LegalSection title="7. Children's Privacy">
        <p>
          You must be at least {config.legal.minimumAge} to create an
          account, and we do not knowingly collect personal information
          from anyone younger. Before an account is created, we ask for a
          date of birth, check it and throw it away; we keep only the fact
          that the check was passed, and when. If you believe your child
          has given us personal information, contact us at the address
          below and we will delete it. See{" "}
          <Link href="/legal/children" className="link link-primary">
            Children&apos;s privacy
          </Link>{" "}
          for the details.
        </p>
      </LegalSection>

      <LegalSection title="8. Contact">
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
      </LegalSection>
    </LegalPage>
  );
}
