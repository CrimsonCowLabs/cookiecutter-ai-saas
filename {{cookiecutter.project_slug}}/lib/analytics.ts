import type { PostHog } from "posthog-js";
import config from "@/config";
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
 *
 * Session replay is part of the same library but its own consent purpose,
 * and off unless config.ts turns `analytics.sessionReplay` on: see
 * `syncRecording`, and docs/compliance.md, "Session recording".
 */

let posthog: PostHog | null = null;
let starting: Promise<void> | null = null;

/**
 * Pages that are never recorded, whatever the visitor agreed to: signing in
 * and up (with the age screen), and the account settings, where billing is.
 * A path matches its own subpaths too.
 */
const NEVER_RECORDED = ["/sign-in", "/sign-up", "/magic-link", "/dashboard/settings"];

/**
 * Whether the page at `pathname` may be recorded right now: the visitor
 * agreed to recording (and analytics), and it isn't a page that never is.
 */
function mayRecord(pathname: string): boolean {
  const never = NEVER_RECORDED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return !never && mayRun("recording");
}

// The page the visitor is on, as the router last reported it to
// syncRecording.
let currentPath: string | null = null;
let recorderLoaded: Promise<unknown> | null = null;

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
      // Recording starts only through syncRecording, never by itself.
      disable_session_recording: true,
      session_recording: {
        // Every input's value is replaced with asterisks before it is
        // recorded, whatever its type, and so is the text of any element
        // marked data-mask (or class ph-mask). Elements marked
        // ph-no-capture aren't recorded at all.
        maskAllInputs: true,
        maskInputOptions: { password: true },
        maskTextSelector: "[data-mask]",
        // No requests' headers or bodies, and no canvases, whatever the
        // PostHog project's settings say.
        recordHeaders: false,
        recordBody: false,
        captureCanvas: { recordCanvas: false },
      },
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      // No feature flags, so no call to fetch them on every page. Session
      // replay only starts once PostHog's project config says recordings are
      // accepted, so with it on the config is fetched (once, from
      // /ingest/array/<key>/config), but flags still aren't.
      advanced_disable_flags: !config.analytics.sessionReplay,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
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
      // A recording also needs its own consent and a page that may be
      // recorded, in case one is still buffered when either goes.
      before_send: (event) => {
        if (!event || !mayRun("analytics")) return null;
        if (event.event === "$snapshot" && !mayRecord(location.pathname)) return null;
        return event;
      },
      // Send each event as it happens rather than queueing them for a few
      // seconds, so nothing measured before a withdrawal goes out after it.
      request_batching: false,
      persistence: "localStorage+cookie",
    });
    posthog = client;
    if (currentPath !== null) syncRecording(currentPath);
  });
  return starting;
}

/**
 * Start or stop session replay to match the visitor's consent and the page
 * they are on, now `pathname`. Call it whenever either changes; it does
 * nothing until PostHog is running.
 *
 * It must run before the browser goes on to anything else after a client-side
 * navigation (from a layout effect, say), so that recording has stopped by
 * the time anything on a page that is never recorded could be seen: stopping
 * disconnects the recorder's observers, which drops the changes they had seen
 * but not yet reported.
 */
export function syncRecording(pathname: string) {
  currentPath = pathname;
  if (!posthog) return;
  if (!mayRecord(pathname)) {
    posthog.stopSessionRecording();
    return;
  }
  // The recorder is bundled with the app, in a chunk of its own downloaded
  // only now, rather than fetched from PostHog's servers, which the browser
  // never contacts (disable_external_dependency_loading).
  recorderLoaded ??= import("posthog-js/dist/lazy-recorder");
  void recorderLoaded.then(() => {
    // The visitor may have moved on, or changed their mind, meanwhile.
    if (posthog && currentPath === pathname && mayRecord(pathname)) {
      posthog.startSessionRecording();
    }
  });
}

/**
 * Stop PostHog after consent is withdrawn: capture nothing more, and delete
 * every cookie and storage key it wrote.
 */
export function stopAnalytics() {
  if (posthog) {
    posthog.stopSessionRecording();
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
