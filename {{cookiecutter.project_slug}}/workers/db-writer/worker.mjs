import fs from "node:fs";
import IORedis from "ioredis";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

const { Pool } = pg;

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("[db-writer] Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);
const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function lookupJob(jobId) {
  const result = await db.execute(sql`
    SELECT id, user_id, status, created_at
    FROM jobs
    WHERE id = ${jobId}
    LIMIT 1
  `);
  return result.rows?.[0] || null;
}

async function persistJobProgress(jobId, payload) {
  const job = await lookupJob(jobId);
  if (!job) return;

  const status = payload.status || "running";
  const progress = toNumber(payload.progress);
  const message = payload.message || null;

  // Log the progress event
  await db.execute(sql`
    INSERT INTO job_events (job_id, user_id, status, progress, message, payload)
    VALUES (
      ${job.id},
      ${job.user_id},
      ${status},
      ${progress},
      ${message},
      ${JSON.stringify(payload)}::jsonb
    )
  `);

  // Update job status based on progress. Concurrent pmessage handlers give no
  // ordering guarantee across channels — a step-boundary "running" event can
  // be handled after the job's own "completed" event that logically followed
  // it, so this must not regress a completed job back to "running". (Caught
  // by scripts/check_stack_health.sh running a real job through a real
  // stack: output was already persisted by persistJobResult, but a late
  // "running" write had clobbered the status column back, leaving the job
  // stuck "running" forever.) Only "completed" is guarded, not
  // "failed"/"cancelled": lib/queue/jobs.ts retries a job under the same
  // jobId (`attempts: 3`), and a retry's own "running" events must still be
  // able to move status off "failed" — a completed job never retries, so it
  // alone is safe to treat as a one-way door.
  if (status === "running") {
    await db.execute(sql`
      UPDATE jobs
      SET status = 'running',
          started_at = COALESCE(started_at, now())
      WHERE id = ${job.id}
        AND status != 'completed'
    `);
  }

  if (status === "completed") {
    await db.execute(sql`
      UPDATE jobs
      SET status = 'completed',
          completed_at = COALESCE(completed_at, now())
      WHERE id = ${job.id}
    `);
  }

  if (status === "failed") {
    await db.execute(sql`
      UPDATE jobs
      SET status = 'failed',
          completed_at = COALESCE(completed_at, now())
      WHERE id = ${job.id}
    `);
  }

  if (status === "cancelled") {
    await db.execute(sql`
      UPDATE jobs
      SET status = 'cancelled',
          completed_at = COALESCE(completed_at, now())
      WHERE id = ${job.id}
    `);
  }
}

async function persistJobResult(jobId, payload) {
  const job = await lookupJob(jobId);
  if (!job) return;

  // Store the full result as JSONB
  await db.execute(sql`
    UPDATE jobs
    SET status = 'completed',
        completed_at = COALESCE(completed_at, now()),
        output = ${JSON.stringify(payload)}::jsonb
    WHERE id = ${job.id}
  `);

  // Log completion event
  await db.execute(sql`
    INSERT INTO job_events (job_id, user_id, status, progress, message, payload)
    VALUES (
      ${job.id},
      ${job.user_id},
      'completed',
      100,
      'Job results persisted',
      ${JSON.stringify(payload)}::jsonb
    )
  `);

  console.log(`[db-writer] persisted result for job ${jobId}`);
}

async function handleMessage(channel, message) {
  let payload;
  try {
    payload = JSON.parse(message);
  } catch {
    return;
  }

  if (channel.startsWith("job:") && channel.endsWith(":progress")) {
    const jobId = channel.split(":")[1];
    await persistJobProgress(jobId, payload);
    return;
  }

  if (channel.startsWith("job:") && channel.endsWith(":result")) {
    const jobId = channel.split(":")[1];
    await persistJobResult(jobId, payload);
    return;
  }
}

async function main() {
  console.log("[db-writer] starting");
  console.log(`[db-writer] redis=${REDIS_URL}`);
  console.log("[db-writer] channels=job:*:progress,job:*:result");

  await sub.psubscribe("job:*:progress");
  await sub.psubscribe("job:*:result");

  // Liveness+connectivity signal for docker-compose.yml's healthcheck: no
  // HTTP surface to probe here, so it reads this file's mtime instead. Only
  // touching it after a successful PING means a process that is still
  // running but has lost Redis reports unhealthy, not just "alive".
  setInterval(async () => {
    try {
      await sub.ping();
      fs.writeFileSync("/tmp/healthy", "");
    } catch (error) {
      console.error("[db-writer] redis ping failed; not touching healthcheck file:", error);
    }
  }, 5000);

  sub.on("pmessage", async (_pattern, channel, message) => {
    try {
      await handleMessage(channel, message);
    } catch (error) {
      console.error("[db-writer] pmessage error:", error);
    }
  });

  sub.on("message", async (channel, message) => {
    try {
      await handleMessage(channel, message);
    } catch (error) {
      console.error("[db-writer] message error:", error);
    }
  });
}

main().catch((error) => {
  console.error("[db-writer] fatal error:", error);
  process.exit(1);
});
