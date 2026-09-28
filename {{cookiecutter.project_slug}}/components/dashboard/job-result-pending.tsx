"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const MAX_ATTEMPTS = 8;
const INTERVAL_MS = 1500;

/**
 * Bridges a real gap in the pipeline: the worker publishes `completed` on the
 * progress channel, which flips `jobs.status`, but the result payload arrives a
 * moment later on the `:result` channel. So a job can briefly be `completed`
 * with `output` still NULL.
 *
 * Rather than telling the user there's no report, poll for a few seconds. If
 * the output never shows up, fall through to `children` (the real empty state).
 */
export function JobResultPending({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (attempts >= MAX_ATTEMPTS) return;

    const timer = setTimeout(() => {
      setAttempts((n) => n + 1);
      router.refresh();
    }, INTERVAL_MS);

    return () => clearTimeout(timer);
  }, [attempts, router]);

  if (attempts >= MAX_ATTEMPTS) return <>{children}</>;

  return (
    <div className="bg-base-200 border border-base-300 rounded-lg p-4 flex items-center gap-2">
      <span className="loading loading-spinner loading-sm text-primary" />
      <span className="text-sm">Finishing up — saving your report...</span>
    </div>
  );
}
