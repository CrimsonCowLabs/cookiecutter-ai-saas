"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { JobStatus } from "@/components/dashboard/job-status";

/**
 * `JobStatus` streams progress but can't re-render a server component when the
 * job finishes. This wrapper refreshes the route so the report appears without
 * the user reloading.
 */
export function JobLiveStatus({ jobId, initialStatus }: { jobId: string; initialStatus: string }) {
  const router = useRouter();

  // Stable identity — JobStatus keys its EventSource effect on this callback.
  const onComplete = useCallback(() => {
    router.refresh();
  }, [router]);

  return <JobStatus jobId={jobId} initialStatus={initialStatus} onComplete={onComplete} />;
}
