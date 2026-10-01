import { eq, desc, count, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, jobs } from "@/lib/db/schema";
import { StatsCard } from "@/components/dashboard/stats-card";
import { NewJobForm } from "@/components/dashboard/new-job-form";
import { readJobInputUrl, URL_REPORT_JOB_TYPE } from "@/lib/url-report";
import { displayUrl } from "@/lib/url";
import Link from "next/link";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });
  if (!user) return null;

  // Get user's recent jobs
  const recentJobs = await db.query.jobs.findMany({
    where: eq(jobs.userId, session.user.id),
    orderBy: desc(jobs.createdAt),
    limit: 5,
  });

  // Get job stats
  const [jobStats] = await db
    .select({
      total: count(),
      completed: sql<number>`count(*) filter (where ${jobs.status} = 'completed')`,
      running: sql<number>`count(*) filter (where ${jobs.status} = 'running')`,
      failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')`,
    })
    .from(jobs)
    .where(eq(jobs.userId, session.user.id));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-base-content/60 mt-1">
          {user.plan === "free" ? "Free plan" : `${user.plan.charAt(0).toUpperCase() + user.plan.slice(1)} plan`}
        </p>
      </div>

      {/* Submit a job */}
      <div id="new-report" className="scroll-mt-6">
        <NewJobForm />
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard label="Total Jobs" value={jobStats?.total ?? 0} />
        <StatsCard label="Completed" value={jobStats?.completed ?? 0} variant="success" />
        <StatsCard label="Running" value={jobStats?.running ?? 0} variant="warning" />
        <StatsCard label="Failed" value={jobStats?.failed ?? 0} variant="error" />
      </div>

      {/* Recent Jobs */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Jobs</h2>
        </div>

        {recentJobs.length === 0 ? (
          <div className="text-center py-12 bg-base-200 rounded-lg">
            <p className="text-base-content/60 mb-4">
              No jobs yet. Paste a URL above to generate your first report.
            </p>
            <a href="#new-report" className="btn btn-primary">
              Create your first report
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job) => {
                  const href = `/dashboard/jobs/${job.id}`;
                  const inputUrl = readJobInputUrl(job.input);
                  const label =
                    job.type === URL_REPORT_JOB_TYPE
                      ? (displayUrl(inputUrl) ?? inputUrl ?? "URL report")
                      : job.type;

                  return (
                    <tr key={job.id} className="hover">
                      <td>
                        <Link href={href} className="block">
                          <p className="font-medium truncate max-w-xs">{label}</p>
                          <p className="text-xs text-base-content/50">{job.type}</p>
                        </Link>
                      </td>
                      <td>
                        <span className={`badge badge-sm ${
                          job.status === "completed" ? "badge-success" :
                          job.status === "running" ? "badge-warning" :
                          job.status === "failed" ? "badge-error" :
                          "badge-ghost"
                        }`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="text-sm text-base-content/60">
                        {new Date(job.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="text-right">
                        <Link href={href} className="link link-hover text-sm text-primary">
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
