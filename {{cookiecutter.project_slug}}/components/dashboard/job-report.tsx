import { displayUrl, safeHttpHref } from "@/lib/url";
import type { UrlReport } from "@/lib/url-report";

interface JobReportProps {
  report: UrlReport;
  /** The URL the job was submitted with, used when the report omits one. */
  requestedUrl?: string | null;
  question?: string | null;
  durationSeconds?: number | null;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Renders a `url-report` payload. Every field is optional in practice — the
 * worker may have produced a partial report — so each section is skipped when
 * empty and the whole thing still reads sensibly.
 *
 * `report.url`, `report.title` and `report.sources` can contain text pulled off
 * a third-party page, so links go through `safeHttpHref` and anything that
 * isn't http(s) is rendered as plain text.
 */
export function JobReport({
  report,
  requestedUrl,
  question,
  durationSeconds,
}: JobReportProps) {
  const sourceHref = safeHttpHref(report.url) ?? safeHttpHref(requestedUrl);
  const heading = report.title.trim() || displayUrl(sourceHref) || "Report";
  const hasBody = Boolean(report.summary.trim()) || report.insights.length > 0;

  return (
    <div className="space-y-6">
      <div className="bg-base-200 rounded-lg p-5 space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{heading}</h2>
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="link link-hover text-sm text-base-content/60 break-all"
            >
              {displayUrl(sourceHref)}
            </a>
          ) : (
            <p className="text-sm text-base-content/60 break-all">
              {report.url || requestedUrl || "Unknown source"}
            </p>
          )}
        </div>

        {question && (
          <div className="border-l-2 border-primary/40 pl-3">
            <p className="text-xs uppercase tracking-wide text-base-content/50">Question</p>
            <p className="text-sm">{question}</p>
          </div>
        )}

        {!report.ai_enhanced && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="text-sm font-medium text-warning">Generated without AI</p>
            <p className="text-sm text-base-content/70 mt-1">
              {report.summary.trim() ||
                "The model didn't produce a report for this page. Add a model API key, or try a page that can be fetched."}
            </p>
          </div>
        )}

        {report.ai_enhanced && report.summary.trim() && (
          <div>
            <h3 className="text-sm font-semibold text-base-content/80 mb-2">Summary</h3>
            <p className="text-sm leading-relaxed whitespace-pre-line">{report.summary}</p>
          </div>
        )}

        {report.insights.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-base-content/80 mb-2">Key insights</h3>
            <ul className="space-y-2">
              {report.insights.map((insight, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span className="text-primary shrink-0">&bull;</span>
                  <span>{insight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!hasBody && (
          <p className="text-sm text-base-content/60">
            This job finished without producing any report text.
          </p>
        )}
      </div>

      {report.sources.length > 0 && (
        <div className="bg-base-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-base-content/80 mb-2">Sources</h3>
          <ul className="space-y-1">
            {report.sources.map((source, i) => {
              const href = safeHttpHref(source);
              return (
                <li key={i} className="text-sm break-all">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="link link-hover text-primary"
                    >
                      {source}
                    </a>
                  ) : (
                    <span className="text-base-content/70">{source}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {typeof durationSeconds === "number" && (
        <p className="text-xs text-base-content/50">
          Generated in {formatDuration(durationSeconds)}
          {report.ai_enhanced ? " with AI" : ""}
        </p>
      )}
    </div>
  );
}
