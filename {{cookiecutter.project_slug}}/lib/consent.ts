import { useSyncExternalStore } from "react";
import config from "@/config";

/**
 * The one place that knows what the visitor has agreed to. Anything that
 * tracks, measures or loads a third party's code asks `mayRun(purpose)`
 * first, and nothing else reads the consent cookie. See docs/compliance.md,
 * "Analytics and consent".
 *
 * The choice lives in a first-party cookie, `consent`, as JSON:
 * `{ "version": "<legal.consentTextVersion>", "analytics": "granted" }`.
 * A cookie written against another version of the consent text counts as no
 * choice at all, so changing `legal.consentTextVersion` in config.ts asks
 * everyone again. A browser that sends a Global Privacy Control signal has
 * refused, whatever the cookie says.
 *
 * Browser-only: on the server every purpose is "unknown".
 */

/** What a visitor can be asked to agree to. Add a purpose here first. */
export type Purpose = "analytics";

/**
 * "granted" or "denied": the visitor chose (or their browser refused for
 * them, see `refusedByBrowser`). "unasked": no choice for the current consent
 * text, so ask. "unknown": not decidable here (the server, or before
 * hydration); treat it as "denied" and don't ask yet.
 */
export type ConsentState = Decision | "unasked" | "unknown";

/** An answer the visitor gave. */
export type Decision = "granted" | "denied";

const COOKIE = "consent";
// Six months, after which the visitor is asked again: the longest most EU
// regulators accept a consent choice being kept (the CNIL's guidance, for
// one).
const MAX_AGE_SECONDS = 60 * 60 * 24 * 182;

type Stored = { version: string } & Partial<Record<Purpose, Decision>>;

const listeners = new Set<() => void>();

function read(): Stored | null {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const stored = JSON.parse(decodeURIComponent(raw));
    return stored?.version === config.legal.consentTextVersion ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Whether the browser itself refuses on the visitor's behalf: a Global
 * Privacy Control signal (navigator.globalPrivacyControl), which California
 * and Colorado law require honouring as an opt-out.
 */
export function refusedByBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** The visitor's current answer for `purpose`. */
export function consentFor(purpose: Purpose): ConsentState {
  if (typeof document === "undefined") return "unknown";
  if (refusedByBrowser()) return "denied";
  return read()?.[purpose] ?? "unasked";
}

/** May `purpose` run right now? Only with an explicit, current "yes". */
export function mayRun(purpose: Purpose): boolean {
  return consentFor(purpose) === "granted";
}

/**
 * Record the visitor's answer for `purpose` against the current consent text,
 * and tell everything listening (see `subscribe`), which starts or stops
 * whatever depends on it.
 */
export function setConsent(purpose: Purpose, decision: Decision) {
  const stored: Stored = { ...read(), version: config.legal.consentTextVersion, [purpose]: decision };
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${COOKIE}=${encodeURIComponent(JSON.stringify(stored))}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  for (const listener of listeners) listener();
}

/** Call `listener` whenever a choice changes. Returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `consentFor(purpose)` as React state, re-rendering when it changes. */
export function useConsent(purpose: Purpose): ConsentState {
  return useSyncExternalStore(
    subscribe,
    () => consentFor(purpose),
    () => "unknown"
  );
}
