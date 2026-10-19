"use server";

import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { createJob } from "@/lib/job-submission";
import { dispatchJob, cancelJob } from "@/lib/queue/jobs";
import { getRedis } from "@/lib/redis";
import { audit } from "@/lib/audit";
import { enforceRateLimit } from "@/lib/rate-limit";

type ActionResult<T = unknown> =
  | { success: true; data?: T }
  | { success: false; error: string };

export async function submitJob(
  type: string,
  input: Record<string, unknown>
): Promise<ActionResult<{ jobId: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  try {
    await enforceRateLimit(`job:${session.user.id}`, 10, 60);
  } catch {
    return { success: false, error: "Too many requests. Please try again later." };
  }

  // Client-side validation is a convenience; this is the enforcement point.
  // createJob refuses unknown job types, input that fails its type's schema,
  // and anything past the user's plan limits, and records only parsed input.
  const created = await createJob(db, { userId: session.user.id, type, input });
  if (!created.ok) return { success: false, error: created.error };
  const { job, plan } = created;

  // Dispatch to BullMQ. If that fails, mark the job failed rather than leave
  // it queued: a queued row holds one of the plan's concurrent-job slots, and
  // nothing else would ever move it. (Not deleted: a throw doesn't prove the
  // queue never got it, so it still counts towards the month.)
  try {
    await dispatchJob({
      jobId: job.id,
      userId: session.user.id,
      type: job.type,
      input: job.input,
      userPlan: plan,
    });
  } catch {
    await db
      .update(jobs)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return { success: false, error: "Couldn't start the job. Please try again." };
  }

  await audit({
    userId: session.user.id,
    action: "job.submit",
    resourceType: "job",
    resourceId: job.id,
    metadata: { type },
  });

  revalidatePath("/dashboard");

  return { success: true, data: { jobId: job.id } };
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // Look up job — verify ownership + cancellable status
  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.id, jobId), eq(jobs.userId, session.user.id)),
  });

  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "queued" && job.status !== "running") {
    return { success: false, error: "Job cannot be cancelled" };
  }

  // Update DB: status = cancelled, completedAt = now
  await db
    .update(jobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(jobs.id, jobId));

  // Try to remove/fail the BullMQ job
  try {
    await cancelJob(jobId);
  } catch {
    // Job may already be gone — that's fine
  }

  // Set Redis cancel flag for worker to detect mid-job (10 min TTL)
  const redis = getRedis();
  await redis.set(`job:${jobId}:cancel`, "1", "EX", 600);

  // Publish cancelled status to Redis for SSE
  await redis.publish(
    `job:${jobId}:progress`,
    JSON.stringify({ status: "cancelled", progress: 0, message: "Job cancelled" })
  );

  await audit({
    userId: session.user.id,
    action: "job.cancel",
    resourceType: "job",
    resourceId: jobId,
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/jobs/${jobId}`);

  return { success: true };
}

export async function getJobStatus(jobId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.id, jobId), eq(jobs.userId, session.user.id)),
  });

  if (!job) return { success: false, error: "Job not found" };

  return {
    success: true,
    data: {
      id: job.id,
      status: job.status,
      type: job.type,
      progress: job.progress,
      output: job.output,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    },
  };
}
