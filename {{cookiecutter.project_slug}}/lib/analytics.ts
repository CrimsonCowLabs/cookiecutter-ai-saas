import type { PostHog } from "posthog-js";
import { mayRun } from "@/lib/consent";

/**
 * PostHog, loaded only once the visitor has agreed to analytics. Browser-only.
 *
 * Nothing here runs, and posthog-js is not even downloaded, until
 * `startAnalytics` is called with consent given (lib/consent.ts): the library
 * is a separate chunk pulled in with a dynamic import(). It then talks only to
 * this app's own /ingest proxy (app/ingest/[...path]/route.ts), never to
 * PostHog directly, so the visitor's browser never contacts another company
 * and PostHog never sees their IP address. See docs/compliance.md, "Analytics
 * and consent".
 */

let posthog: PostHog | null = null;
let starting: Promise<void> | null = null;

/**
 * Start PostHog with the project key, if the visitor has agreed to analytics.
 * Safe to call more than once; a call after `stopAnalytics` turns it back on.
 */
export function startAnalytics(key: string): Promise<void> {
  if (!mayRun("analytics")) return Promise.resolve();
  if (posthog) {
    posthog.set_config({ disable_persistence: false });
    posthog.opt_in_capturing();
    return Promise.resolve();
  }
  starting ??= import("posthog-js").then(({ default: client }) => {
    // Consent may have been withdrawn while the library downloaded.
    if (!mayRun("analytics")) {
      starting = null;
      return;
    }
    client.init(key, {
      // Through this app's own domain, never PostHog's.
      api_host: "/ingest",
      defaults: "2026-08-30",
      // Page views, including the client-side navigations Next.js makes, and
      // nothing else unless the app calls trackEvent.
      capture_pageview: "history_change",
      autocapture: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      // No feature flags, so no call to fetch them on every page.
      advanced_disable_flags: true,
      // Never inject another script (recorder, surveys, toolbar, site apps).
      disable_external_dependency_loading: true,
      // Keep its cookie on this host only, so withdrawal can clear it.
      cross_subdomain_cookie: false,
      // The proxy already withholds the visitor's IP address from PostHog;
      // this keeps it out of the event properties too.
      property_denylist: ["$ip"],
      // Every event asks lib/consent.ts again on its way out, so nothing is
      // sent once consent is gone, whatever posthog-js's own opt-out state
      // says (stopAnalytics deletes that along with the rest of its storage).
      before_send: (event) => (mayRun("analytics") ? event : null),
      // Send each event as it happens rather than queueing them for a few
      // seconds, so nothing measured before a withdrawal goes out after it.
      request_batching: false,
      persistence: "localStorage+cookie",
    });
    posthog = client;
  });
  return starting;
}

/**
 * Stop PostHog after consent is withdrawn: capture nothing more, and delete
 * every cookie and storage key it wrote.
 */
export function stopAnalytics() {
  if (posthog) {
    posthog.opt_out_capturing();
    // Stops it saving anything, and deletes what it saved.
    posthog.set_config({ disable_persistence: true });
  }
  clearPostHogStorage();
}

/**
 * Record a custom event, such as "signed up" or "report exported", if the
 * visitor has agreed to analytics and PostHog is running. Otherwise it does
 * nothing, so call it freely.
 */
export function trackEvent(name: string, properties?: Record<string, unknown>) {
  if (posthog && mayRun("analytics")) posthog.capture(name, properties);
}

/**
 * Delete PostHog's cookies (`ph_<key>_posthog`, ...) and its localStorage and
 * sessionStorage keys (`ph_...`, `__ph_...`), including the opt-out flag:
 * the consent cookie is the record of the choice, not PostHog.
 */
function clearPostHogStorage() {
  const ours = (key: string) => key.startsWith("ph_") || key.startsWith("__ph_");
  for (const name of document.cookie.split("; ").map((c) => c.split("=")[0])) {
    if (ours(name)) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) if (ours(key)) storage.removeItem(key);
  }
}
