// A stand-in for PostHog's ingestion API, so the analytics-consent and
// session-replay tests can see every request the running app's first-party
// proxy (/ingest) forwards, without a PostHog project or a network connection.
//
// scripts/check_compliance.sh boots the app with POSTHOG_HOST and
// POSTHOG_ASSETS_HOST pointing at http://localhost:<port> (production points
// them at PostHog's own hosts), so app/ingest/[...path]/route.ts forwards here.
// Each request is recorded, headers, body and all, and answered the way
// PostHog answers it.
//
// It plays a PostHog project with session replay turned ON in its settings,
// the most the project side can allow: whether anything is recorded is then
// down to the app alone (config.ts's analytics.sessionReplay and the visitor's
// consent), which is what the tests are about.
//
// Zero dependencies: node:http and node:zlib only.
import http from "node:http";
import zlib from "node:zlib";

export const FAKE_POSTHOG_PORT = Number(process.env.FAKE_POSTHOG_PORT || 3996);

// The paths posthog-js sends captured events to: /e/ and /i/v0/e/ today,
// /batch/, /capture/ and /track/ in older versions.
const CAPTURE_PATH = /^\/(e|i\/v0\/e|batch|capture|track)\/?$/;

// Where recordings go: the endpoint the remote config below names.
const RECORDING_ENDPOINT = "/s/";

// posthog-js's remote config for the project (/array/<token>/config), as
// PostHog sends it for a project with session replay on.
const REMOTE_CONFIG = {
  sessionRecording: { endpoint: RECORDING_ENDPOINT },
  supportedCompression: ["gzip", "gzip-js"],
  hasFeatureFlags: false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GZIP_MAGIC = "\x1f\x8b";

/**
 * A request body as the JSON value posthog-js encoded, whichever way it did:
 * gzipped, base64 in a `data=` form field, or plain JSON. null when there is
 * no body or it is none of those.
 */
function decodeBody(buffer) {
  if (buffer.length === 0) return null;
  try {
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) return JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
    const text = buffer.toString("utf8");
    if (text.startsWith("data=")) {
      const data = new URLSearchParams(text).get("data");
      try {
        return JSON.parse(data);
      } catch {
        return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      }
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `value` with every string the recorder gzipped on its own (whole snapshots,
 * and the fields of DOM mutations, as latin1 strings starting with the gzip
 * magic bytes) unpacked back into the JSON it was.
 */
function unpack(value) {
  if (typeof value === "string" && value.startsWith(GZIP_MAGIC)) {
    try {
      return unpack(JSON.parse(zlib.gunzipSync(Buffer.from(value, "latin1")).toString("utf8")));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
  }
  return value;
}

/**
 * Start the fake API. Returns:
 *
 *   requests — every request the proxy forwarded so far, in order:
 *     { method, path, search, headers, events } (headers lower-cased, as node
 *     gives them; events, the events the body carried, unpacked).
 *   captures() — the ones that carried events (see CAPTURE_PATH).
 *   recordings(since = 0) — the session-recording uploads among requests
 *     from index `since` on: every `$snapshot` event received, as the text of
 *     what it recorded (the page's DOM, mutations and input, unpacked), so a
 *     test can look for what should never have been recorded.
 *   settled() — the number of requests received, once none has arrived for a
 *     second: a page closed by the previous test can still send what it had
 *     queued as it unloads.
 *   close()
 */
export async function startFakePostHog() {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake-posthog");
      const body = unpack(decodeBody(Buffer.concat(chunks)));
      const events = [body ?? []].flat().filter((e) => e && typeof e === "object" && "event" in e);
      requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, events });
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith("/static/")) {
        // Recordings, surveys and the toolbar load scripts from here. The app
        // bundles the recorder and turns the rest off, so nothing should ask.
        return json(404, { detail: "fake PostHog: no static assets" });
      }
      if (url.pathname.startsWith("/flags") || url.pathname.startsWith("/decide")) {
        return json(200, { flags: {}, featureFlags: {}, errorsWhileComputingFlags: false });
      }
      if (/^\/array\/[^/]+\/config$/.test(url.pathname)) return json(200, REMOTE_CONFIG);
      if (url.pathname.startsWith("/array/")) return json(404, { detail: "fake PostHog: no scripts" });
      json(200, { status: 1 });
    });
  });
  await new Promise((resolve) => server.listen(FAKE_POSTHOG_PORT, resolve));

  return {
    requests,
    captures: () => requests.filter((r) => CAPTURE_PATH.test(r.path)),
    recordings: (since = 0) =>
      requests
        .slice(since)
        .flatMap((r) => r.events)
        .filter((e) => e.event === "$snapshot")
        .map((e) => JSON.stringify(e.properties?.$snapshot_data ?? e.properties)),
    async settled() {
      let count = -1;
      while (count !== requests.length) {
        count = requests.length;
        await sleep(1000);
      }
      return count;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
