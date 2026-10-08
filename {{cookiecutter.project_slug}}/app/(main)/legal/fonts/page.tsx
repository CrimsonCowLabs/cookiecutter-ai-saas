import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Fonts & third-party requests | __PROJECT_NAME__",
};

export default function FontsPage() {
  return (
    <LegalPage
      title="Fonts & third-party requests"
      intro="Why no page of __PROJECT_NAME__ makes your browser contact another company's server before you agree to it."
    >
      <LegalSection title="The risk">
        <p>
          Whenever a web page loads a font, script, stylesheet or image from
          another company&apos;s server, your browser sends that server your IP
          address. Under the EU&apos;s General Data Protection Regulation
          (GDPR), an IP address is personal data, and passing it on needs a
          legal basis, usually your consent.
        </p>
        <p>
          The best-known example is fonts. In January 2022 the Munich Regional
          Court ordered a website to pay a visitor &euro;100 in damages, and to
          stop, because its pages loaded Google Fonts from Google&apos;s servers
          and so sent the visitor&apos;s IP address to Google without asking
          (LG M&uuml;nchen I, judgment of 20 January 2022, case 3 O 17493/20).
          Each visitor can bring a claim of their own, and a wave of demand
          letters followed. Data protection authorities can also fine up to
          &euro;20 million or 4% of worldwide annual turnover, whichever is
          higher (GDPR Article 83(5)). Figures as of October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">Fonts come from this site.</strong>{" "}
          The app&apos;s typefaces are loaded with Next.js&apos;s{" "}
          <code>next/font</code>, which downloads them once, when the app is
          built, and serves them from this site&apos;s own domain. Your browser
          never asks Google, or any other font service, for them.
        </p>
        <p>
          <strong className="text-base-content">So does everything else.</strong>{" "}
          Stylesheets, scripts and images are served from this domain too.
          Nothing that would contact another server, such as analytics, ads,
          embedded videos or social media widgets, loads before you agree to it.
          {/* cc:begin analytics */}
          {" "}Even once you agree to analytics, your browser sends it only to
          this site, which passes it on; see{" "}
          <Link href="/legal/analytics" className="link link-primary">Analytics &amp; recording</Link>.
          {/* cc:end analytics */}
        </p>
        <p>
          <strong className="text-base-content">Leaving is your choice.</strong>{" "}
          You only reach another company&apos;s site when you choose to: for
          example, signing in with an outside account takes you to that
          provider&apos;s sign-in page.
          {/* cc:begin stripe */}
          {" "}Paying for a plan takes you to Stripe&apos;s checkout page.
          {/* cc:end stripe */}
        </p>
        <p>
          <strong className="text-base-content">It is checked automatically.</strong>{" "}
          The app&apos;s test suite opens the home page, the sign-in and sign-up
          pages, every page under{" "}
          <Link href="/legal" className="link link-primary">Legal</Link> and the
          dashboard in a real browser, and fails if any of them tries to contact
          another server.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
