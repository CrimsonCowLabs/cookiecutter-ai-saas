import type { ReactNode } from "react";
import type { PlanConfig } from "@/types/config";
import { renewalTerms } from "@/lib/renewal-terms";

/**
 * A subscribe or upgrade button with the plan's automatic-renewal terms
 * (lib/renewal-terms.ts) directly beneath it. `children` renders the button
 * and is handed the id to put in its `aria-describedby`, so a screen reader
 * reads the terms with the button. For a plan that never renews it gets
 * undefined and no terms are shown.
 *
 * Every button that leads to a subscription checkout goes through this, at
 * most once per plan on a page.
 */
export function WithRenewalTerms({
  plan,
  children,
}: {
  plan: PlanConfig;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const terms = renewalTerms(plan);
  const id = `renewal-terms-${plan.tier}`;
  return (
    <div className="space-y-2">
      {children(terms ? id : undefined)}
      {terms && (
        <p id={id} className="text-xs leading-relaxed text-base-content/70">
          {terms}
        </p>
      )}
    </div>
  );
}
