"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Closes the dashboard's checkbox-driven mobile drawer (see
 * app/(main)/dashboard/layout.tsx) whenever the route changes.
 *
 * DashboardLayout wraps every /dashboard/* route, so Next.js keeps it (and
 * the drawer's uncontrolled <input type="checkbox"> DOM node) mounted across
 * client-side navigations — nothing unchecks it on its own, so a phone user
 * who opens the drawer and taps a Sidebar link is left staring at the
 * overlay/drawer still covering the page they just navigated to. This
 * renders nothing; it only watches the pathname and flips the checkbox back
 * off, which is the smallest amount of client JS that fixes it without
 * converting the layout or Sidebar themselves into client components.
 */
export function DrawerAutoClose({ drawerId }: { drawerId: string }) {
  const pathname = usePathname();

  useEffect(() => {
    const drawerToggle = document.getElementById(drawerId);
    if (drawerToggle instanceof HTMLInputElement) {
      drawerToggle.checked = false;
    }
  }, [drawerId, pathname]);

  return null;
}
