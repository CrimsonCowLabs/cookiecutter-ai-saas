import type { Metadata } from "next";
import Link from "next/link";
import config from "@/config";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Children's privacy | __PROJECT_NAME__",
};

const { minimumAge } = config.legal;

/**
 * The children's privacy notice. Linked from the Privacy Policy; the
 * minimum age is the one the age screen enforces (config.legal.minimumAge).
 * Deliberately not linked from the age screen itself, which must not say what
 * age is needed.
 */
export default function ChildrensPrivacyPage() {
  return (
    <LegalPage
      title="Children's privacy"
      intro={`Who can create an account on __PROJECT_NAME__, and what happens with a child's information.`}
    >
      <LegalSection title="The risk">
        <p>
          In the United States, the Children&apos;s Online Privacy Protection
          Act (COPPA) forbids a website from collecting personal information,
          such as an email address, from a child under 13 without first getting
          verifiable consent from a parent. The Federal Trade Commission
          enforces it with civil penalties of up to $53,088 for each violation,
          and each child can count as a separate violation.
        </p>
        <p>
          In the European Union, the General Data Protection Regulation (GDPR,
          Article 8) sets the age at which a child can consent on their own at
          16, and lets each country lower it to as little as 13. Figures as of
          October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">
            You must be at least {minimumAge} to create an account.
          </strong>{" "}
          __PROJECT_NAME__ is not meant for younger children, and we do not
          knowingly collect personal information from anyone under {minimumAge}.
        </p>
        <p>
          <strong className="text-base-content">Everyone is asked first.</strong>{" "}
          Before an account can be created, whichever way you sign up, the
          sign-up page asks for a date of birth. It does not suggest an answer
          or say what age is needed. Someone under {minimumAge} is told we can&apos;t create an account for
          them, and the page will not ask again for a day.
        </p>
        <p>
          <strong className="text-base-content">Your date of birth is not kept.</strong>{" "}
          It is checked and then thrown away: it is not saved in our database,
          in a cookie or in our logs. For someone who is turned away, we keep
          nothing at all, not even an email address. For an account, we record
          only that the check was passed, and when.
        </p>
        <p>
          <strong className="text-base-content">If you are a parent.</strong>{" "}
          If you believe your child under {minimumAge} has given us personal
          information, email{" "}
          <a href="mailto:__AUTHOR_EMAIL__" className="link link-primary">
            __AUTHOR_EMAIL__
          </a>
          . We will delete the account and the information connected to it,
          and tell you when it is done. See also our{" "}
          <Link href="/privacy-policy" className="link link-primary">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
