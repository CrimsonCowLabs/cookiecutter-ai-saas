import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import IORedis from "ioredis";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { jobs, jobEvents } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * SSE endpoint that streams job progress updates.
 * The Python worker publishes events to Redis channel `job:{jobId}:progress`.
 * Events are JSON: { status, progress?, message?, detail? }. `detail` is present
 * on events from inside a step (agent steps, tool calls) and is passed through.
 *
 * The stream ends when the job reaches a terminal state (completed/failed/cancelled).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Verify job ownership
  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.id, jobId), eq(jobs.userId, session.user.id)),
  });

  if (!job) {
    return new Response("Not found", { status: 404 });
  }

  const latestEvent = await db.query.jobEvents.findFirst({
    where: eq(jobEvents.jobId, jobId),
    orderBy: (events, { desc }) => [desc(events.createdAt)],
  });

  // If job is already terminal, return current state immediately
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    const encoder = new TextEncoder();
    const body = encoder.encode(
      `data: ${JSON.stringify({
        status: job.status,
        progress: latestEvent?.progress ?? 100,
        message: latestEvent?.message ?? undefined,
      })}\n\n`
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const channel = `job:${jobId}:progress`;

      // Create a dedicated Redis subscriber
      const subscriber = new IORedis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: null,
      });

      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
      };

      const safeClose = () => {
        if (closed) return;
        try {
          controller.close();
        } catch {
          // Ignore double-close errors
        }
      };

      // Send initial state
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            status: latestEvent?.status ?? job.status,
            progress: latestEvent?.progress ?? 0,
            message: latestEvent?.message ?? undefined,
          })}\n\n`
        )
      );

      subscriber.subscribe(channel, (err) => {
        if (err) {
          console.error("Redis subscribe error:", err);
          cleanup();
          safeClose();
        }
      });

      subscriber.on("message", (_ch: string, message: string) => {
        if (closed) return;

        try {
          controller.enqueue(encoder.encode(`data: ${message}\n\n`));

          const parsed = JSON.parse(message);
          if (
            parsed.status === "completed" ||
            parsed.status === "failed" ||
            parsed.status === "cancelled"
          ) {
            cleanup();
            safeClose();
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Timeout: close after 10 minutes to prevent leaked connections
      const timeout = setTimeout(() => {
        cleanup();
        safeClose();
      }, 10 * 60 * 1000);

      // Poll DB as fallback every 10s in case Redis messages were missed
      const pollInterval = setInterval(async () => {
        if (closed) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const current = await db.query.jobs.findFirst({
            where: eq(jobs.id, jobId),
          });
          if (
            current &&
            (current.status === "completed" || current.status === "failed" || current.status === "cancelled")
          ) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ status: current.status, progress: 100 })}\n\n`
              )
            );
            cleanup();
            clearInterval(pollInterval);
            clearTimeout(timeout);
            safeClose();
          }
        } catch {
          // Ignore poll errors
        }
      }, 10_000);

      // Handle client disconnect
      req.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        cleanup();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
