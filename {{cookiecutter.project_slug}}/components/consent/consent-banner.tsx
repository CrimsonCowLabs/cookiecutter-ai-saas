"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { refusedByBrowser, setConsent, useConsent, type Decision } from "@/lib/consent";
import { startAnalytics, stopAnalytics } from "@/lib/analytics";
import { CHOICE_BUTTON, closeChoices, markConfigured, useChoices } from "@/components/consent/choices";

/**
 * Asks the visitor whether analytics may run, and starts or stops PostHog to
 * match their answer (lib/analytics.ts). Rendered once, by AnalyticsConsent,
 * only when POSTHOG_KEY is set.
 *
 * It sits at the top of the page, in the normal flow, right after the skip
 * link: it covers nothing, needs no answer before the page can be used (no
 * answer means no analytics), and the keyboard reaches it in order and passes
 * on. It shows while the visitor has not chosen for the current consent text,
 * and again whenever they use "Privacy choices".
 */
export function ConsentBanner({ posthogKey }: { posthogKey: string }) {
  const consent = useConsent("analytics");
  const { reopened } = useChoices();
  const banner = useRef<HTMLElement>(null);

  useEffect(markConfigured, []);

  useEffect(() => {
    if (consent === "granted") void startAnalytics(posthogKey);
    // Refused, withdrawn, or asked for a newer consent text: no PostHog, and
    // nothing of it left in the browser.
    else if (consent !== "unknown") stopAnalytics();
  }, [consent, posthogKey]);

  useEffect(() => {
    if (reopened) banner.current?.focus();
  }, [reopened]);

  if (consent === "unknown" || (consent !== "unasked" && !reopened)) return null;

  const choose = (decision: Decision) => {
    setConsent("analytics", decision);
    closeChoices();
  };

  return (
    <section
      id="consent-banner"
      ref={banner}
      tabIndex={-1}
      aria-labelledby="consent-banner-title"
      className="border-b border-base-content/10 bg-base-200"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 text-sm">
          <p id="consent-banner-title" className="font-semibold text-base-content">
            Analytics
          </p>
          {refusedByBrowser() ? (
            <p className="text-base-content/80">
              Your browser sends a Global Privacy Control signal, so we
              don&apos;t run analytics for you. To allow it, turn the signal
              off in your browser.{" "}
              <Link href="/legal/analytics" className="link link-primary">
                Analytics &amp; recording
              </Link>
            </p>
          ) : (
            <p className="text-base-content/80">
              May we measure how __PROJECT_NAME__ is used, with PostHog, to
              improve it? Nothing is collected unless you accept, and you can
              change your mind at any time.{" "}
              <Link href="/legal/analytics" className="link link-primary">
                What we would collect
              </Link>
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {refusedByBrowser() ? (
            <button type="button" className={CHOICE_BUTTON} onClick={closeChoices}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className={CHOICE_BUTTON} onClick={() => choose("granted")}>
                Accept
              </button>
              <button type="button" className={CHOICE_BUTTON} onClick={() => choose("denied")}>
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
