import { ReactNode } from "react";
import { connection } from "next/server";

/**
 * Minimal root layout - actual layouts are in route groups:
 * - (main) - Main app with your styles
 *
 * Every page is rendered per request, never prerendered at build time: the
 * Content-Security-Policy (lib/csp.ts) lets a script run only with the nonce
 * made for that one response, and Next.js can only put it on its scripts
 * while rendering for that request. A page prerendered at build time would
 * carry no nonce, so none of its scripts would run. `connection()` is what
 * opts every page under this layout into that.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return children;
}
