import { connection } from "next/server";
import { ConsentBanner } from "@/components/consent/consent-banner";

/**
 * The consent banner, when analytics is set up. Rendered once, by
 * app/(main)/layout.tsx.
 *
 * POSTHOG_KEY is read on the server at request time, not baked into the
 * client bundle as a NEXT_PUBLIC_ variable, so the same Docker image runs
 * with or without analytics and the key can change without a rebuild.
 * `connection()` is what makes it request time: without it Next.js would
 * read the variable once, while prerendering at build time. Unset, there is
 * no banner and nothing loads.
 */
export async function AnalyticsConsent() {
  await connection();
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  return <ConsentBanner posthogKey={key} />;
}
