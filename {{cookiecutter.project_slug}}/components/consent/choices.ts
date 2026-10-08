import { useSyncExternalStore } from "react";

/**
 * Shared UI state for the consent controls, which live in different parts of
 * the page (the banner at the top, "Privacy choices" in the footer, the
 * controls on /legal/analytics): whether analytics is set up at all, and
 * whether the visitor has asked to see the choice again. The choice itself is
 * lib/consent.ts's business, not this file's.
 */
export interface ChoicesState {
  /** POSTHOG_KEY is set, so there is something to consent to. */
  configured: boolean;
  /** "Privacy choices" was used: show the banner even though they chose. */
  reopened: boolean;
}

/**
 * "Accept" and "Reject" look exactly alike, so neither is the easy way out:
 * EU regulators treat a refusal that is harder to find or click than the
 * acceptance as no valid consent at all.
 */
export const CHOICE_BUTTON = "btn btn-sm btn-neutral w-28";

const SERVER_STATE: ChoicesState = { configured: false, reopened: false };
let state = SERVER_STATE;
// Where focus goes back to once the reopened banner closes.
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<ChoicesState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Called by the banner when it mounts with a project key. */
export function markConfigured() {
  if (!state.configured) update({ configured: true });
}

/** Show the banner again, returning focus to `from` once a choice is made. */
export function reopenChoices(from?: HTMLElement) {
  opener = from ?? null;
  update({ reopened: true });
}

/** Hide the banner after a choice, and return focus to whatever reopened it. */
export function closeChoices() {
  const returnTo = opener;
  opener = null;
  if (state.reopened) update({ reopened: false });
  returnTo?.focus();
}

export function useChoices(): ChoicesState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => SERVER_STATE
  );
}
