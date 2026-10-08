import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
// cc:begin analytics
import config from "@/config";
import { AnalyticsChoices } from "@/components/consent/analytics-choices";
// cc:end analytics

export const metadata: Metadata = {
  title: "Analytics & recording | __PROJECT_NAME__",
};

/**
 * What is measured about a visit, by whom and for how long, and the
 * visitor's choice about it.
 */
export default function AnalyticsPage() {
  return (
    <LegalPage
      title="Analytics & recording"
      intro="What __PROJECT_NAME__ measures about your visit, who does it for us, and the choices you have."
    >
      <LegalSection title="The risk">
        <p>
          Analytics tools work by storing an identifier in your browser, in a
          cookie or similar storage, and reading it back on every page you
          visit. In the EU and the UK, the ePrivacy rules allow that without
          your consent only when it is strictly necessary for a service you
          asked for, which analytics is not. Consent has to be a free, informed
          and specific choice, made before anything is stored, as easy to
          refuse as to give, and as easy to withdraw as it was to give (GDPR
          Article 7). France&apos;s data protection authority fined Google
          &euro;150 million and Facebook &euro;60 million in January 2022
          because their sites made refusing cookies harder than accepting them.
        </p>
        <p>
          In California, a business has to treat a Global Privacy Control
          signal from your browser as a request to opt out of having your
          personal information sold or shared; in 2022 the California Attorney
          General settled with Sephora for $1.2 million, in part for ignoring
          it. Session recording, which replays what you did on a page, carries
          the same rules and more, because it can capture what you type.
          Figures as of October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        {/* cc:begin analytics */}
        <p>
          <strong className="text-base-content">Nothing until you agree.</strong>{" "}
          We use PostHog to see which pages are used, so we can improve them.
          It doesn&apos;t run, and its code isn&apos;t even downloaded, until
          you choose &ldquo;Accept&rdquo;. If you choose &ldquo;Reject&rdquo;,
          or don&apos;t choose at all, nothing is measured and nothing is
          stored in your browser for analytics. Both buttons are the same, and
          neither is in your way: you can use the whole site without
          answering.
        </p>
        <p>
          <strong className="text-base-content">What is collected.</strong>{" "}
          If you accept: the address and title of each page you view on this
          site and the page you came from, your browser, operating system and
          screen size, and a random identifier stored in your browser (a cookie
          and local storage named after our PostHog project, beginning
          &ldquo;ph_&rdquo;) so that your visits can be counted together. We
          don&apos;t record what you click or type, we don&apos;t record your
          screen, and we don&apos;t link these measurements to your account.
        </p>
        <p>
          <strong className="text-base-content">Who receives it.</strong>{" "}
          PostHog, Inc. stores and processes it for us, as our processor, and
          may not use it for anything else. Your browser never contacts PostHog
          itself: it sends the measurements to this site, which passes them on
          without your cookies and without your IP address, so PostHog
          doesn&apos;t learn your IP address or your location from it.
        </p>
        <p>
          <strong className="text-base-content">How long it is kept.</strong>{" "}
          The measurements are kept for {config.legal.analyticsRetention}, then
          deleted. The identifier in your browser lasts up to a year, or until
          you withdraw. Your answer itself is kept in a cookie named
          &ldquo;consent&rdquo; for six months, after which we ask again, and
          we also ask again whenever what we collect changes.
        </p>
        <p>
          <strong className="text-base-content">Your browser&apos;s signal counts.</strong>{" "}
          If your browser sends a Global Privacy Control signal, we treat it as
          &ldquo;Reject&rdquo;: we don&apos;t ask, and nothing is measured.
        </p>
        <p>
          <strong className="text-base-content">Changing your mind.</strong>{" "}
          Use the controls below, or &ldquo;Privacy choices&rdquo; at the
          bottom of the home page, at any time. Turning analytics off stops it
          at once and deletes what PostHog stored in your browser.
        </p>
        <AnalyticsChoices />
        {/* cc:end analytics */}
        {/* cc:begin no-analytics */}
        <p>
          <strong className="text-base-content">Nothing is tracked.</strong>{" "}
          __PROJECT_NAME__ uses no analytics service and no session recording.
          We don&apos;t measure which pages you visit, and we store nothing in
          your browser to recognise you across visits. The only cookies we
          set are the ones the site needs to work, such as the one that keeps
          you signed in.
        </p>
        <p>
          <strong className="text-base-content">If that changes.</strong>{" "}
          Before we add any analytics, we will ask for your consent first,
          make refusing as easy as accepting, and update this page.
        </p>
        {/* cc:end no-analytics */}
        <p>
          See also{" "}
          <Link href="/legal/fonts" className="link link-primary">
            Fonts &amp; third-party requests
          </Link>{" "}
          and the{" "}
          <Link href="/privacy-policy" className="link link-primary">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
