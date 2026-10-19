// Job submission enforces the user's plan (issue #102): no one can run up the
// LLM bill beyond what their plan allows. app/actions/jobs.ts's submitJob
// queues nothing that createJob (lib/job-submission.ts) hasn't admitted, so
// this file loads that module itself, through tsx, and runs it against a real
// Postgres: a job type with no input schema is refused, input that fails its
// type's schema is refused, a user at their plan's jobsPerMonth is refused
// until the month turns, and parallel submissions never get past
// concurrentJobs.
//
// Needs only Postgres with the schema pushed: no app, no Redis (createJob
// records the job; dispatching it is submitJob's next step).
// scripts/check_jobs.sh in the template repository sets one up.
//
// Env vars (see tests/auth/support.mjs for defaults): DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { config, connectDb, insertTestUser, deleteTestUser } from "../auth/support.mjs";

// Read by lib/db as it loads.
process.env.DATABASE_URL = config.databaseUrl;
// The project's .ts files are CommonJS to Node (package.json has no
// "type": "module"), so both of tsx's loaders are needed; either one
// resolves the "@/" imports through tsconfig.json. Exports land on
// `.default` (see tests/compliance/marketing-email.test.mjs).
registerEsm();
registerCjs();
const appConfig = (await import("../../config.ts")).default.default;
const { createJob } = (await import("../../lib/job-submission.ts")).default;
const { db: moduleDb } = (await import("../../lib/db/index.ts")).default;

const limitsOf = (tier) => appConfig.stripe.plans.find((p) => p.tier === tier).limits;
const FREE = limitsOf("free");
const PRO = limitsOf("pro");

const URL_REPORT = "url-report";
const validInput = { url: "https://example.com/article", question: "What is it about?" };

let db;
before(async () => {
  db = await connectDb();
});
after(async () => {
  await db?.end();
  await moduleDb.$client.end();
});

/** Run `fn(user)` as a freshly inserted user on `plan`, deleted (with their jobs) afterwards. */
async function asNewUser(fn, { plan = "free" } = {}) {
  const user = await insertTestUser(db);
  try {
    await db.query("update users set plan = $2 where id = $1", [user.id, plan]);
    return await fn(user);
  } finally {
    await deleteTestUser(db, user.id);
  }
}

async function jobsOf(userId) {
  const { rows } = await db.query("select type, status, input from jobs where user_id = $1", [userId]);
  return rows;
}

/** Record `count` finished jobs for `userId`, submitted at `createdAt`. */
async function insertFinishedJobs(userId, count, createdAt) {
  await db.query(
    `insert into jobs (user_id, type, status, created_at)
     select $1, 'url-report', 'completed', $2 from generate_series(1, $3)`,
    [userId, createdAt, count]
  );
}

/** Midnight UTC on the first of this month, as a string Postgres reads as UTC. */
function startOfMonthUtc(monthsAgo = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1)).toISOString();
}

test("a job type with no input schema is refused, and nothing is recorded", async () => {
  await asNewUser(async (user) => {
    const result = await createJob(moduleDb, {
      userId: user.id,
      type: "unregistered-type",
      input: { url: "https://example.com/", question: "x".repeat(1_000_000) },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown job type/i);
    assert.deepEqual(await jobsOf(user.id), []);
  });
});

test("an inherited property name is not a job type", async () => {
  await asNewUser(async (user) => {
    const result = await createJob(moduleDb, { userId: user.id, type: "constructor", input: validInput });
    assert.equal(result.ok, false);
    assert.deepEqual(await jobsOf(user.id), []);
  });
});

test("input that fails its type's schema is refused, and nothing is recorded", async () => {
  await asNewUser(async (user) => {
    const result = await createJob(moduleDb, {
      userId: user.id,
      type: URL_REPORT,
      input: { url: "https://example.com/", question: "x".repeat(1_000_000) },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /500 characters/);
    assert.deepEqual(await jobsOf(user.id), []);
  });
});

test("a valid job is recorded queued, with only the input its schema let through", async () => {
  await asNewUser(async (user) => {
    const result = await createJob(moduleDb, {
      userId: user.id,
      type: URL_REPORT,
      input: { ...validInput, url: `  ${validInput.url}  `, extra: "y".repeat(10_000) },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.plan, "free");
    assert.deepEqual(result.job.input, validInput);
    assert.deepEqual(await jobsOf(user.id), [{ type: URL_REPORT, status: "queued", input: validInput }]);
  });
});

test("a user at their plan's monthly limit is refused, with a message naming it", async () => {
  await asNewUser(async (user) => {
    await insertFinishedJobs(user.id, FREE.jobsPerMonth, startOfMonthUtc());
    const result = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`\\b${FREE.jobsPerMonth}\\b`));
    assert.match(result.error, /month/);
    assert.equal((await jobsOf(user.id)).length, FREE.jobsPerMonth, "nothing more should be recorded");
  });
});

test("cancelled and failed jobs count towards the monthly limit", async () => {
  await asNewUser(async (user) => {
    await insertFinishedJobs(user.id, FREE.jobsPerMonth, startOfMonthUtc());
    await db.query(
      "update jobs set status = (case when random() < 0.5 then 'failed' else 'cancelled' end)::job_status where user_id = $1",
      [user.id]
    );
    const result = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(result.ok, false);
  });
});

test("the monthly count starts again with each calendar month (UTC)", async () => {
  await asNewUser(async (user) => {
    // All of last month's allowance, the last of it a second before this month began.
    await insertFinishedJobs(user.id, FREE.jobsPerMonth - 1, startOfMonthUtc(1));
    await insertFinishedJobs(user.id, 1, new Date(Date.parse(startOfMonthUtc()) - 1000).toISOString());
    const result = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(result.ok, true, result.error);
  });
});

test("the monthly limit is the user's own plan's", async () => {
  await asNewUser(
    async (user) => {
      await insertFinishedJobs(user.id, FREE.jobsPerMonth, startOfMonthUtc());
      const result = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
      assert.equal(result.ok, true, result.error);
    },
    { plan: "pro" }
  );
});

test("a job in progress holds a concurrency slot; a finished one doesn't", async () => {
  await asNewUser(async (user) => {
    assert.equal(FREE.concurrentJobs, 1, "this test assumes the free plan runs one job at a time");
    const first = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(first.ok, true, first.error);

    const second = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(second.ok, false);
    assert.match(second.error, /in progress/);

    await db.query("update jobs set status = 'running' where id = $1", [first.job.id]);
    assert.equal((await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput })).ok, false);

    await db.query("update jobs set status = 'completed' where id = $1", [first.job.id]);
    const third = await createJob(moduleDb, { userId: user.id, type: URL_REPORT, input: validInput });
    assert.equal(third.ok, true, third.error);
  });
});

/**
 * Fire `n` submissions for `userId` at once, and return their results. The
 * module's pool is first made to hold `n` open connections, so that none of
 * them waits on a connection being made, which could otherwise let the first
 * finish before the rest start and hide a race.
 */
async function submitInParallel(userId, n) {
  const pool = moduleDb.$client;
  assert.ok(n <= pool.options.max, `the pool must be able to hold ${n} connections`);
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  clients.forEach((c) => c.release());
  return Promise.all(
    Array.from({ length: n }, () => createJob(moduleDb, { userId, type: URL_REPORT, input: validInput }))
  );
}

test("parallel submissions from a user who may run one job start exactly one", async () => {
  await asNewUser(async (user) => {
    const results = await submitInParallel(user.id, 8);
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    assert.equal((await jobsOf(user.id)).length, 1);
    for (const r of results.filter((r) => !r.ok)) assert.match(r.error, /in progress/);
  });
});

test("parallel submissions never take a user past their plan's concurrency", async () => {
  await asNewUser(
    async (user) => {
      const results = await submitInParallel(user.id, 8);
      assert.equal(results.filter((r) => r.ok).length, PRO.concurrentJobs, JSON.stringify(results));
      assert.equal((await jobsOf(user.id)).length, PRO.concurrentJobs);
    },
    { plan: "pro" }
  );
});

test("parallel submissions never take a user past their monthly limit", async () => {
  await asNewUser(
    async (user) => {
      await insertFinishedJobs(user.id, PRO.jobsPerMonth - 1, startOfMonthUtc());
      const results = await submitInParallel(user.id, 8);
      assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
      assert.equal((await jobsOf(user.id)).length, PRO.jobsPerMonth);
    },
    { plan: "pro" }
  );
});

test("an unknown user is refused", async () => {
  const result = await createJob(moduleDb, {
    userId: "00000000-0000-4000-8000-000000000000",
    type: URL_REPORT,
    input: validInput,
  });
  assert.equal(result.ok, false);
});
