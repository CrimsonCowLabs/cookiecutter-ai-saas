import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import config from "@/config";

export const metadata: Metadata = {
  title: "Accessibility | __PROJECT_NAME__",
};

export default function AccessibilityPage() {
  const { contactEmail, reviewDate } = config.legal.accessibility;

  return (
    <LegalPage
      title="Accessibility"
      intro="Our accessibility statement: the standard __PROJECT_NAME__ is built to, where it still falls short, and how to tell us about a barrier."
    >
      <LegalSection title="The risk">
        <p>
          A website that people with disabilities cannot use shuts them out,
          and in many places it is also against the law. In the United States,
          many courts have applied Title III of the Americans with Disabilities
          Act (ADA) to websites, and thousands of lawsuits over inaccessible sites
          are filed every year. In California, the Unruh Civil Rights Act adds
          damages of at least $4,000 per violation (California Civil Code
          &sect;52(a)).
        </p>
        <p>
          In the European Union, the European Accessibility Act (Directive (EU)
          2019/882) has applied since 28 June 2025 to online services sold to
          consumers, including e-commerce. Each member state sets its own
          penalties; in Germany, for example, fines reach &euro;100,000. Figures
          as of October 2026.
        </p>
      </LegalSection>

      <LegalSection title="How this app handles it">
        <p>
          <strong className="text-base-content">Our target is WCAG 2.2 Level AA.</strong>{" "}
          The Web Content Accessibility Guidelines (WCAG), published by the
          W3C, are the standard that courts, regulators and the European
          standard EN 301 549 all point to.
        </p>
        <p>
          <strong className="text-base-content">Everything works from the keyboard.</strong>{" "}
          The first press of Tab on every page offers a &ldquo;Skip to
          content&rdquo; link past the navigation, and whatever has keyboard
          focus is outlined clearly.
        </p>
        <p>
          <strong className="text-base-content">Text is readable in both themes.</strong>{" "}
          Text meets WCAG&apos;s contrast minimums in the light and the dark
          theme.
        </p>
        <p>
          <strong className="text-base-content">It is checked automatically.</strong>{" "}
          The app&apos;s test suite opens the home page, the sign-in and sign-up
          pages, every legal page, the dashboard and the account settings in a
          real browser, in both themes, and fails if an automated WCAG 2.2 AA
          audit finds any problem, if the skip link stops working, or if
          anything the keyboard can reach has no visible focus outline.
        </p>
      </LegalSection>

      <LegalSection title="Known limitations">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Automated checks find only some accessibility problems. Things like
            whether a screen reader&apos;s reading order makes sense, or whether
            an image&apos;s description is helpful, take a person to judge.
          </li>
          <li>
            Reports and other text written by AI are shown as they are
            generated, and may not always use headings, lists and link text
            the way an accessible document should.
          </li>
          <li>
            Some steps take you to another company&apos;s pages, whose
            accessibility we do not control: signing in with an outside
            account
            {/* cc:begin stripe */}
            , and paying through Stripe
            {/* cc:end stripe */}
            .
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Report a barrier">
        <p>
          If something on __PROJECT_NAME__ is hard or impossible for you to
          use, please tell us at{" "}
          <a href={`mailto:${contactEmail}`} className="link link-primary">
            {contactEmail}
          </a>
          . Say which page you were on, what you were trying to do, and, if
          you use one, which browser and assistive technology (such as a
          screen reader or magnifier). We read every report, and if we cannot
          fix the problem quickly we will help you get what you needed another
          way.
        </p>
      </LegalSection>

      <LegalSection title="About this statement">
        <p>
          This statement was last reviewed on{" "}
          {/* dateTime only takes a real date, not the shipped placeholder. */}
          <time dateTime={/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) ? reviewDate : undefined}>
            {reviewDate}
          </time>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
