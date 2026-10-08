import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Email preferences | __PROJECT_NAME__",
};

/**
 * Which emails the app sends, which of them are marketing, and how to stop
 * those. Marketing email goes only through sendMarketingEmail
 * (lib/marketing-email.ts), which adds the unsubscribe link and postal
 * address and skips anyone who has opted out.
 */
export default function EmailPreferencesPage() {
  return (
    <LegalPage
      title="Email preferences"
      intro="Which emails __PROJECT_NAME__ sends, which of them are marketing, and how to stop the ones you don't want."
    >
      <LegalSection title="The risk">
        <p>
          In the United States, the CAN-SPAM Act sets the rules for commercial
          email: every message that advertises a product or service has to
          say who sent it, give a valid postal address, and offer a working
          way to opt out, and the sender must honour an opt-out within 10
          business days and never email that address again. The Federal
          Trade Commission enforces it with civil penalties of up to $53,088
          for each email that breaks the rules. Figures as of October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">Marketing email.</strong>{" "}
          News about our product, offers and other promotional messages are
          marketing email. Every one ends with our postal address and a link
          to unsubscribe, and carries the standard unsubscribe headers, so
          your email app can show its own unsubscribe button.
        </p>
        <p>
          <strong className="text-base-content">Transactional email.</strong>{" "}
          Some emails are part of using the service, not marketing, and are
          sent whether or not you have unsubscribed:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          {/* cc:begin magic-link */}
          <li>the sign-in link you ask for when you sign in by email;</li>
          {/* cc:end magic-link */}
          {/* cc:begin contact */}
          <li>our replies to a message you send us through the contact form;</li>
          {/* cc:end contact */}
          {/* cc:begin stripe */}
          <li>
            the confirmation of a new subscription, with its renewal terms and
            how to cancel, and receipts and billing notices about your
            payments;
          </li>
          {/* cc:end stripe */}
          <li>notices about your account, security or these terms.</li>
        </ul>
        <p>
          <strong className="text-base-content">How to opt out.</strong>{" "}
          Use the unsubscribe link at the bottom of any marketing email, or
          the unsubscribe button your email app shows next to it. The link
          opens a page with a single button to confirm; you don&apos;t need
          to sign in, and you don&apos;t need an account. Your email app&apos;s
          button unsubscribes you in one click. Either way, we stop sending
          you marketing email straight away.
        </p>
        <p>
          <strong className="text-base-content">An opt-out lasts.</strong>{" "}
          We keep a list of the addresses that have opted out, separate from
          accounts, and check it before every marketing email. Deleting your
          account, or creating a new one later with the same address, does
          not put you back on our mailing list. Unsubscribing again changes
          nothing, and the unsubscribe page never says whether an address has
          an account with us.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
