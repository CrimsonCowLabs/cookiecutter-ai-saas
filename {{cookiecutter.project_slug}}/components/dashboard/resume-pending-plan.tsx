"use client";

import { useEffect, useRef } from "react";
import { getPendingPlanId, forgetPendingPlan } from "@/lib/pending-plan";
import { startCheckoutAction } from "@/app/actions/billing";

/**
 * Mounted once in the dashboard layout. A visitor who picked a paid plan
 * before signing up lands here with `pending_plan_id` still set (see
 * lib/pending-plan.ts) — this consumes it and sends them on to checkout, so
 * the choice they made isn't silently dropped (issue #27).
 *
 * The cookie is forgotten in the same effect that reads it, before the
 * action even runs, so a slow network or a failed checkout never leaves the
 * visitor stuck being redirected to Stripe on every dashboard visit.
 *
 * Deliberately avoids React state: the plan id is written straight into the
 * hidden input's DOM value and the form submitted imperatively, both inside
 * one effect. Storing it in state instead would mean calling setState from
 * an effect body just to trigger a second render that submits the form —
 * exactly the cascading-render pattern this repo's react-hooks/
 * set-state-in-effect lint rule exists to catch.
 *
 * A real form submission, not a bare client call to the action, so
 * startCheckoutAction's redirect() is handled by Next's normal form-action
 * navigation path — the same mechanism the sidebar's sign-out button relies
 * on.
 */
export function ResumePendingPlan() {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const pending = getPendingPlanId();
    if (!pending) return;
    forgetPendingPlan();
    if (inputRef.current) inputRef.current.value = pending;
    formRef.current?.requestSubmit();
  }, []);

  return (
    <form ref={formRef} action={startCheckoutAction} hidden>
      <input ref={inputRef} type="hidden" name="planId" />
    </form>
  );
}
