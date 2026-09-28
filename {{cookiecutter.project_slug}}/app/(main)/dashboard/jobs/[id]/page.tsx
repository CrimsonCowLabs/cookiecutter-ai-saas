import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import config from "@/config";
import { CancelJobButton } from "@/components/dashboard/cancel-job-button";
import { JobLiveStatus } from "@/components/dashboard/job-live-status";
import { JobReport } from "@/components/dashboard/job-report";
import { JobResultPending } from "@/components/dashboard/job-result-pending";
import {
  parseUrlReportOutput,
  readJobInputQuestion,
  readJobInputUrl,
  URL_REPORT_JOB_TYPE,
} from "@/lib/url-report";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const statusBadge: Record<string, string> = {
  completed: "badge-success",
  running: "badge-warning",
  queued: "badge-ghost",
  failed: "badge-error",
  cancelled: "badge-ghost",
};

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) redirect(config.auth.loginUrl);

  // Non-UUID ids would blow up the query, so treat them as missing.
  if (!UUID_RE.test(id)) notFound();

  // Ownership boundary: scope the lookup to the signed-in user so another
  // user's job id is indistinguishable from one that doesn't exist.
  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.id, id), eq(jobs.userId, session.user.id)),
  });
  if (!job) notFound();

  const isTerminal = ["completed", "failed", "cancelled"].includes(job.status);
  const requestedUrl = readJobInputUrl(job.input);
  const question = readJobInputQuestion(job.input);
  const { report, durationSeconds, error } = parseUrlReportOutput(job.output);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-base-content/60 hover:text-base-content"
        >
          <span aria-hidden="true">&larr;</span> Back to dashboard
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">
              {job.type === URL_REPORT_JOB_TYPE ? "URL report" : job.type}
            </h1>
            <span className={`badge badge-sm ${statusBadge[job.status] ?? "badge-ghost"}`}>
              {job.status}
            </span>
          </div>
          <p className="text-sm text-base-content/60 mt-1 break-all">
            {requestedUrl ?? job.id}
          </p>
          <p className="text-xs text-base-content/40 mt-1">
            Submitted{" "}
            {new Date(job.createdAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </div>

        {!isTerminal && <CancelJobButton jobId={job.id} />}
      </div>

      {!isTerminal && <JobLiveStatus jobId={job.id} initialStatus={job.status} />}

      {job.status === "failed" && (
        <div className="bg-error/10 border border-error/20 rounded-lg p-4">
          <p className="font-medium text-error">This job failed</p>
          <p className="text-sm text-base-content/70 mt-1">
            {error ?? "The worker didn't record a reason. Try submitting the URL again."}
          </p>
        </div>
      )}

      {job.status === "cancelled" && (
        <div className="bg-base-200 border border-base-300 rounded-lg p-4">
          <p className="font-medium">This job was cancelled</p>
          <p className="text-sm text-base-content/60 mt-1">
            Nothing was generated. Submit the URL again to retry.
          </p>
        </div>
      )}

      {job.status === "completed" &&
        (report ? (
          <JobReport
            report={report}
            requestedUrl={requestedUrl}
            question={question}
            durationSeconds={durationSeconds}
          />
        ) : (
          <JobResultPending>
            <div className="bg-base-200 border border-base-300 rounded-lg p-4 space-y-3">
              <div>
                <p className="font-medium">No readable report</p>
                <p className="text-sm text-base-content/60 mt-1">
                  This job completed but didn&apos;t produce a report in the expected
                  shape. It may have run on an older worker version.
                </p>
              </div>
              {job.output != null && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-base-content/60">
                    Show raw output
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-base-300 p-3 text-xs">
                    {JSON.stringify(job.output, null, 2).slice(0, 4000)}
                  </pre>
                </details>
              )}
            </div>
          </JobResultPending>
        ))}
    </div>
  );
}
