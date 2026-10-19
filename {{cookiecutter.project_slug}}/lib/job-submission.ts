import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { db as appDb } from "@/lib/db";
import { jobs, users } from "@/lib/db/schema";
import { getPlanConfig } from "@/lib/plans";
import { getJobInputSchema } from "@/lib/validations";
import type { PlanTier } from "@/types/config";

type Db = typeof appDb;

export type CreateJobResult =
  | { ok: true; job: { id: string; type: string; input: Record<string, unknown> }; plan: PlanTier }
  | { ok: false; error: string };

/** Statuses that hold one of the plan's `concurrentJobs` slots. */
const IN_PROGRESS = ["queued", "running"] as const;

/**
 * The start of the period `jobsPerMonth` counts over: the current calendar
 * month in UTC. Not the Stripe billing period: `users` doesn't record one,
 * free users have none, and a subscription's period (in `subscriptions`)
 * lags behind its webhook. A calendar month is the same for everyone and
 * says plainly when the count starts again.
 */
function usagePeriod(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const formatDay = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * Record a job for `userId`, queued, if their plan allows it. Every job comes
 * through here (app/actions/jobs.ts's submitJob dispatches only what this
 * admits), so:
 *
 *   - A job type with no input schema in `jobInputSchemas` is refused, and a
 *     registered one's input must pass its schema. What's recorded, and so
 *     what the worker receives, is the parsed input, never `input` as given.
 *   - A user who has submitted their plan's `jobsPerMonth` this month is
 *     refused. Every job submitted counts, finished, failed or cancelled:
 *     each may already have spent on the model.
 *   - A user with their plan's `concurrentJobs` queued or running is refused.
 *
 * The counting and the insert happen under a per-user advisory lock, held to
 * the end of the transaction, so parallel submissions are checked one after
 * another and can't all pass on the same count. Being advisory, it never
 * blocks the webhook's writes to the user's row (as a `FOR UPDATE` on it
 * would); it only makes the user's other submissions wait their turn.
 */
export async function createJob(
  database: Db,
  { userId, type, input }: { userId: string; type: string; input: unknown }
): Promise<CreateJobResult> {
  const schema = getJobInputSchema(type);
  if (!schema) return { ok: false, error: "Unknown job type." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid job input" };
  }
  const jobInput = parsed.data as Record<string, unknown>;

  return database.transaction(async (tx): Promise<CreateJobResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"jobs:" + userId}, 0))`);

    const [user] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
    if (!user) return { ok: false, error: "User not found" };
    const plan = getPlanConfig(user.plan);
    const { jobsPerMonth, concurrentJobs } = plan.limits;

    const period = usagePeriod();
    const [{ used }] = await tx
      .select({ used: count() })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), gte(jobs.createdAt, period.start)));
    if (used >= jobsPerMonth) {
      return {
        ok: false,
        error:
          `You've used all ${jobsPerMonth} jobs the ${plan.name} plan allows this month. ` +
          `Your count starts again on ${formatDay.format(period.end)}.`,
      };
    }

    const [{ active }] = await tx
      .select({ active: count() })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), inArray(jobs.status, [...IN_PROGRESS])));
    if (active >= concurrentJobs) {
      return {
        ok: false,
        error:
          concurrentJobs === 1
            ? "You already have a job in progress. Wait for it to finish."
            : `You already have ${concurrentJobs} jobs in progress. Wait for one to finish.`,
      };
    }

    const [job] = await tx
      .insert(jobs)
      .values({ userId, type, input: jobInput, status: "queued" })
      .returning({ id: jobs.id });
    return { ok: true, job: { id: job.id, type, input: jobInput }, plan: user.plan };
  });
}
