"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { offered, refusedByBrowser, setConsent, setConsents, useConsent, type Decision } from "@/lib/consent";
import { startAnalytics, stopAnalytics, syncRecording } from "@/lib/analytics";
import { CHOICE_BUTTON, closeChoices, markConfigured, useChoices } from "@/components/consent/choices";

/**
 * Asks the visitor whether analytics may run, and starts or stops PostHog to
 * match their answer (lib/analytics.ts). Rendered once, by AnalyticsConsent,
 * only when POSTHOG_KEY is set.
 *
 * When config.ts turns session replay on, it also offers recording, as a
 * separate box the visitor has to tick themselves: "Accept" agrees to
 * analytics, and to recording only if the box is ticked; "Reject" refuses
 * both. It starts and stops recording to match, and as the visitor moves
 * between pages, since some are never recorded.
 *
 * It sits at the top of the page, in the normal flow, right after the skip
 * link: it covers nothing, needs no answer before the page can be used (no
 * answer means no analytics), and the keyboard reaches it in order and passes
 * on. It shows while the visitor has not chosen for the current consent text,
 * and again whenever they use "Privacy choices".
 */
export function ConsentBanner({ posthogKey }: { posthogKey: string }) {
  const consent = useConsent("analytics");
  const recording = useConsent("recording");
  const { reopened } = useChoices();
  const pathname = usePathname();
  const banner = useRef<HTMLElement>(null);
  const recordingBox = useRef<HTMLInputElement>(null);

  useEffect(markConfigured, []);

  useEffect(() => {
    if (consent === "granted") void startAnalytics(posthogKey);
    // Refused, withdrawn, or asked for a newer consent text: no PostHog, and
    // nothing of it left in the browser.
    else if (consent !== "unknown") stopAnalytics();
  }, [consent, posthogKey]);

  // A layout effect, so that a client-side navigation to a page that is never
  // recorded stops the recording before the browser does anything else.
  useLayoutEffect(() => {
    syncRecording(pathname);
  }, [pathname, consent, recording]);

  useEffect(() => {
    if (reopened) banner.current?.focus();
  }, [reopened]);

  // Asked again when recording is offered and a visitor who accepted
  // analytics hasn't answered about it yet (it was turned on after they
  // chose, say). Someone who refused analytics has refused recording too.
  const unanswered = consent === "unasked" || (consent === "granted" && recording === "unasked");
  if (consent === "unknown" || (!unanswered && !reopened)) return null;

  const offerRecording = offered("recording") && !refusedByBrowser();

  const choose = (decision: Decision) => {
    if (decision === "granted" && offerRecording) {
      setConsents({ analytics: "granted", recording: recordingBox.current?.checked ? "granted" : "denied" });
    } else {
      setConsent("analytics", decision);
    }
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
          {offerRecording && (
            <label className="flex items-start gap-2 pt-1 text-base-content/80">
              <input
                id="consent-recording"
                ref={recordingBox}
                type="checkbox"
                className="checkbox checkbox-sm mt-0.5"
                defaultChecked={recording === "granted"}
              />
              <span>
                Also record my visits, so you can replay them. Everything I
                type stays hidden.
              </span>
            </label>
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
