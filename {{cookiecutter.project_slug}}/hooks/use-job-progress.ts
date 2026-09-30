"use client";

import { useEffect, useState, useCallback } from "react";

interface JobProgress {
  status: string;
  progress?: number;
  message?: string;
  /** Set on events from inside a step, e.g. an agent step or tool call. */
  detail?: { kind: string; step?: number; tool?: string; tool_calls?: number };
}

type ConnectionState = "idle" | "connecting" | "connected" | "error" | "closed";

export function useJobProgress(
  jobId: string | null,
  initialStatus: string
) {
  const [progress, setProgress] = useState<JobProgress>({
    status: initialStatus,
    progress: 0,
  });
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const isTerminal =
    progress.status === "completed" || progress.status === "failed" || progress.status === "cancelled";

  const shouldConnect =
    jobId !== null && !isTerminal && (initialStatus === "queued" || initialStatus === "running");

  useEffect(() => {
    if (!shouldConnect || !jobId) return;

    let eventSource: EventSource | null = null;

    const connect = () => {
      setConnectionState("connecting");
      eventSource = new EventSource(`/api/jobs/${jobId}/progress`);

      eventSource.onopen = () => {
        setConnectionState("connected");
      };

      eventSource.onmessage = (event) => {
        try {
          const data: JobProgress = JSON.parse(event.data);
          setProgress(data);
          setLastEventAt(Date.now());

          if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
            eventSource?.close();
            setConnectionState("closed");
          }
        } catch {
          // Ignore parse errors
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        setConnectionState("error");
        // Reconnect after 5s on error
        setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      eventSource?.close();
      setConnectionState("closed");
    };
  }, [jobId, shouldConnect]);

  const refresh = useCallback(() => {
    if (jobId) {
      setProgress((prev) => ({ ...prev }));
    }
  }, [jobId]);

  return { ...progress, isTerminal, refresh, connectionState, lastEventAt };
}
