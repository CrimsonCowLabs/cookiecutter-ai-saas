import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";

export default function TermsOfServicePage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated={new Date()}>
      <LegalSection title="1. Scope of Service">
        <p>
          __PROJECT_NAME__ provides AI-powered data processing and automation
          tools. By using the service, you agree to these terms and conditions.
        </p>
      </LegalSection>

      <LegalSection title="2. User Responsibilities">
        <p>
          You are responsible for the data you submit and ensuring that your
          use of the service complies with applicable laws and regulations.
          You must not use the service for illegal, harmful, or abusive purposes.
        </p>
      </LegalSection>

      <LegalSection title="3. Data Processing">
        <p>
          We process your submitted data using AI models to generate results.
          Results are provided for informational purposes and you are
          responsible for reviewing and acting on them.
        </p>
      </LegalSection>

      <LegalSection title="4. Service Limits">
        <p>
          Usage may be rate-limited or restricted based on your plan. We may
          modify or suspend the service to maintain platform stability.
        </p>
      </LegalSection>

      {/* cc:begin stripe */}
      <LegalSection title="5. Payment and Automatic Renewal">
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
      </LegalSection>
      {/* cc:end stripe */}
      {/* cc:begin no-stripe */}
      <LegalSection title="5. Fees">
        <p>
          Prices for paid plans are shown on our website. We will tell you
          what a plan costs, and ask for your agreement, before charging
          you anything.
        </p>
      </LegalSection>
      {/* cc:end no-stripe */}

      <LegalSection title="6. Copyright and Repeat Infringers">
        <p>
          You must not use the service to infringe anyone&apos;s copyright.
          If you believe material on the service infringes yours, send a
          notice to our designated copyright agent; if material of yours
          was removed and you believe that was a mistake, you can send a
          counter-notice. We respond to valid notices under the Digital
          Millennium Copyright Act, and in appropriate circumstances we
          close the accounts of users who are repeat infringers. See{" "}
          <Link href="/legal/copyright" className="link link-primary">
            Copyright &amp; DMCA
          </Link>{" "}
          for our agent&apos;s details and what a notice must contain.
        </p>
      </LegalSection>

      <LegalSection title="7. Disclaimer">
        <p>
          __PROJECT_NAME__ provides the service &quot;as is&quot; without warranties of
          any kind. AI-generated results may not be 100% accurate and should
          be reviewed before acting upon them.
        </p>
      </LegalSection>

      <LegalSection title="8. Limitation of Liability">
        <p>
          To the maximum extent permitted by law, we are not liable for any
          indirect, incidental, special, consequential, or punitive damages
          resulting from your use of the service.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes">
        <p>
          We may update these Terms from time to time. Continued use of the
          service after updates constitutes acceptance of the revised Terms.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
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
      </LegalSection>
    </LegalPage>
  );
}
