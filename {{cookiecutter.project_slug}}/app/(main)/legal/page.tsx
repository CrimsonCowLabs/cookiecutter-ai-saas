import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { legalTopics } from "@/lib/legal-topics";

export const metadata: Metadata = {
  title: "Legal | __PROJECT_NAME__",
};

export default function LegalHubPage() {
  return (
    <LegalPage
      title="Legal"
      intro="Our policies, and a plain explanation of how this app handles the legal risks that are common for online services."
      back={{ href: "/", label: "Back to home" }}
    >
      <LegalSection title="Policies">
        <ul className="space-y-2">
          <li>
            <Link href="/privacy-policy" className="link link-primary">Privacy Policy</Link>
          </li>
          <li>
            <Link href="/tos" className="link link-primary">Terms of Service</Link>
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How this app handles common risks">
        <ul className="space-y-4">
          {legalTopics.map((topic) => (
            <li key={topic.title}>
              {topic.href ? (
                <Link href={topic.href} className="link link-primary font-medium">
                  {topic.title}
                </Link>
              ) : (
                <span className="font-medium text-base-content">
                  {topic.title}{" "}
                  <span className="text-sm font-normal text-base-content/60">(page coming soon)</span>
                </span>
              )}
              <p className="text-sm text-base-content/70">{topic.summary}</p>
            </li>
          ))}
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
