// A stand-in for PostHog's ingestion API, so the analytics-consent tests can
// see every request the running app's first-party proxy (/ingest) forwards,
// without a PostHog project or a network connection.
//
// scripts/check_compliance.sh boots the app with POSTHOG_HOST and
// POSTHOG_ASSETS_HOST pointing at http://localhost:<port> (production points
// them at PostHog's own hosts), so app/ingest/[...path]/route.ts forwards here.
// Each request is recorded, headers and all, and answered the way PostHog
// answers it.
//
// Zero dependencies: node:http only.
import http from "node:http";

export const FAKE_POSTHOG_PORT = Number(process.env.FAKE_POSTHOG_PORT || 3996);

// The paths posthog-js sends captured events to: /e/ and /i/v0/e/ today,
// /batch/, /capture/ and /track/ in older versions.
const CAPTURE_PATH = /^\/(e|i\/v0\/e|batch|capture|track)\/?$/;

/**
 * Start the fake API. Returns { requests, captures, close }:
 *
 *   requests — every request the proxy forwarded so far, in order:
 *     { method, path, search, headers } (headers lower-cased, as node gives them).
 *   captures() — the ones that carried events (see CAPTURE_PATH).
 */
export async function startFakePostHog() {
  const requests = [];

  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url, "http://fake-posthog");
      requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers });
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith("/static/")) {
        // Recordings, surveys and the toolbar load scripts from here. The app
        // turns all of them off, so nothing should ask.
        return json(404, { detail: "fake PostHog: no static assets" });
      }
      if (url.pathname.startsWith("/flags") || url.pathname.startsWith("/decide")) {
        return json(200, { flags: {}, featureFlags: {}, errorsWhileComputingFlags: false });
      }
      if (url.pathname.startsWith("/array/")) return json(200, {});
      json(200, { status: 1 });
    });
  });
  await new Promise((resolve) => server.listen(FAKE_POSTHOG_PORT, resolve));

  return {
    requests,
    captures: () => requests.filter((r) => CAPTURE_PATH.test(r.path)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
