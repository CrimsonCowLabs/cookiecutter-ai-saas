const PENDING_PLAN_COOKIE = "pending_plan_id";
const ONE_HOUR_SECONDS = 60 * 60;

/**
 * Remember which plan the visitor picked before they authenticated, so checkout
 * can resume after the OAuth or magic-link round trip.
 *
 * Lives at module scope on purpose: writing `document.cookie` directly inside a
 * component body trips react-hooks/immutability under the React Compiler.
 */
export function rememberPendingPlan(planId: string): void {
  document.cookie = `${PENDING_PLAN_COOKIE}=${encodeURIComponent(
    planId
  )}; path=/; max-age=${ONE_HOUR_SECONDS}; SameSite=Lax`;
}

/**
 * Read back the plan `rememberPendingPlan` stashed, if any. Client-only
 * (reads `document.cookie`) for the same reason `rememberPendingPlan` writes
 * it client-side: a Server Component can read cookies but cannot clear them,
 * and the post-auth landing page needs to do both in one pass so a visitor
 * is never sent to checkout twice for the same choice.
 */
export function getPendingPlanId(): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${PENDING_PLAN_COOKIE}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/** Clear the cookie `rememberPendingPlan` wrote, once it has been acted on. */
export function forgetPendingPlan(): void {
  document.cookie = `${PENDING_PLAN_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

/**
 * Build the post-auth redirect, carrying the chosen plan through as a query
 * param and a cookie.
 */
export function buildAuthRedirectUrl(
  callbackUrl: string | undefined,
  planId: string | undefined
): string {
  const redirectUrl = callbackUrl || "/dashboard";
  if (!planId) return redirectUrl;

  const url = new URL(redirectUrl, window.location.origin);
  url.searchParams.set("plan_id", planId);
  rememberPendingPlan(planId);
  return url.toString();
}
