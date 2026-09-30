"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelJobAction } from "@/app/actions/jobs";

export function CancelJobButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onCancel = () => {
    setError(null);
    startTransition(async () => {
      const result = await cancelJobAction(jobId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onCancel}
        className="btn btn-outline btn-error min-h-11"
        disabled={isPending}
      >
        {isPending ? <span className="loading loading-spinner loading-xs" /> : "Cancel job"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
