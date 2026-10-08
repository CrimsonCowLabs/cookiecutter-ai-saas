"use client";

import { refusedByBrowser, setConsent, useConsent } from "@/lib/consent";
import { CHOICE_BUTTON, useChoices } from "@/components/consent/choices";

const DESCRIBE = {
  granted: "on: you accepted analytics",
  denied: "off: you rejected analytics",
  unasked: "off: you haven't chosen yet",
} as const;

/**
 * The analytics choice on /legal/analytics: what it is now, and buttons to
 * turn analytics on or off. Turning it off stops PostHog at once and clears
 * what it stored in the browser (the banner reacts to the change; see
 * ConsentBanner).
 */
export function AnalyticsChoices() {
  const consent = useConsent("analytics");
  const { configured } = useChoices();

  let body;
  if (consent === "unknown") {
    body = <p>Loading your current choice&hellip;</p>;
  } else if (!configured) {
    body = <p>Analytics is not set up on this site, so nothing is measured.</p>;
  } else if (refusedByBrowser()) {
    body = (
      <p>
        Your browser sends a Global Privacy Control signal, which we treat as
        a refusal, so analytics is off for you. To allow it, turn the signal
        off in your browser&apos;s privacy settings.
      </p>
    );
  } else {
    body = (
      <>
        <p role="status">
          Analytics is <strong className="text-base-content">{DESCRIBE[consent]}</strong>.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={CHOICE_BUTTON} onClick={() => setConsent("analytics", "granted")}>
            Turn analytics on
          </button>
          <button type="button" className={CHOICE_BUTTON} onClick={() => setConsent("analytics", "denied")}>
            Turn analytics off
          </button>
        </div>
      </>
    );
  }

  return (
    <div id="analytics-choices" className="space-y-3 rounded-box border border-base-content/10 p-4">
      {body}
    </div>
  );
}
