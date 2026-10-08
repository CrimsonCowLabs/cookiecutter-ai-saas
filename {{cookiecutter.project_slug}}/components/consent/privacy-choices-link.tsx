"use client";

import { reopenChoices, useChoices } from "@/components/consent/choices";

/**
 * "Privacy choices" in the footer: shows the consent banner again, so a
 * visitor can change or withdraw their answer from any page that has the
 * footer. Nothing to show when analytics is not set up.
 */
export function PrivacyChoicesLink() {
  const { configured } = useChoices();
  if (!configured) return null;
  return (
    <li>
      <button
        type="button"
        className="cursor-pointer hover:text-base-content transition-colors"
        onClick={(e) => reopenChoices(e.currentTarget)}
      >
        Privacy choices
      </button>
    </li>
  );
}
