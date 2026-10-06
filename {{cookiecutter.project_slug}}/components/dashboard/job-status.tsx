"use client";

import { useEffect, useState } from "react";

interface JobProgress {
  status: string;
  progress: number;
  message?: string;
  /** Set on events from inside a step, e.g. an agent step or tool call. */
  detail?: { kind: string; step?: number; tool?: string; tool_calls?: number };
}

type ConnectionState = "idle" | "connecting" | "connected" | "error" | "closed";

interface JobStatusProps {
  jobId: string;
  initialStatus: string;
  onComplete?: () => void;
}

export function JobStatus({ jobId, initialStatus, onComplete }: JobStatusProps) {
  const [progress, setProgress] = useState<JobProgress>({
    status: initialStatus,
    progress: 0,
  });
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ["completed", "failed", "cancelled"].includes(initialStatus)
      ? "idle"
      : "connecting"
  );

  const isTerminal = ["completed", "failed", "cancelled"].includes(progress.status);

  useEffect(() => {
    if (isTerminal || !jobId) return;

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const eventSource = new EventSource(`/api/jobs/${jobId}/progress`);

    eventSource.onopen = () => {
      setConnectionState("connected");
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as JobProgress;
        setProgress(data);

        if (["completed", "failed", "cancelled"].includes(data.status)) {
          eventSource.close();
          setConnectionState("closed");
          onComplete?.();
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      setConnectionState("error");
      eventSource.close();

      // Reconnect after 5s
      reconnectTimer = setTimeout(() => {
        setConnectionState("connecting");
      }, 5000);
    };

    return () => {
      clearTimeout(reconnectTimer);
      eventSource.close();
    };
  }, [jobId, isTerminal, onComplete]);

  if (isTerminal && progress.status === "completed") {
    return (
      <div className="bg-success/10 border border-success/20 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="font-medium text-success">Job completed</span>
        </div>
      </div>
    );
  }

  if (isTerminal && progress.status === "failed") {
    return (
      <div className="bg-error/10 border border-error/20 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="font-medium text-error">Job failed</span>
        </div>
        {progress.message && (
          <p className="text-sm text-base-content/60 mt-2">{progress.message}</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-base-200 border border-base-300 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="loading loading-spinner loading-sm text-primary" />
          <span className="text-sm font-medium">
            {progress.message || `Processing... ${progress.status}`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {connectionState === "connected" && (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
              </span>
              <span className="text-xs font-medium text-success">Live</span>
            </>
          )}
          <span className="text-xs text-base-content/70 ml-1">{progress.progress}%</span>
        </div>
      </div>
      <div className="h-1.5 bg-base-content/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-linear-to-r from-primary to-primary/70 rounded-full transition-all duration-300"
          style={{ width: `${progress.progress}%` }}
        />
      </div>
    </div>
  );
}
