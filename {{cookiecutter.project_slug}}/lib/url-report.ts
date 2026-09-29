import { z } from "zod";

/**
 * Reading `jobs.output` for the `url-report` job.
 *
 * `jobs.output` is JSONB written by the Python worker, so from this side it is
 * `unknown`: a job may predate the current worker, may have been written by a
 * half-finished run, or may have failed before producing a report. Everything
 * here degrades to `null`/empty rather than throwing, and callers render a
 * fallback state instead of a crashed page.
 *
 * The worker's envelope is:
 *   { job_id, job_type, user_id, status, duration_seconds, results }
 * and the user-visible payload lives at `results["Results Generation"]`.
 */

export const URL_REPORT_JOB_TYPE = "url-report";

const RESULT_STEP_KEY = "Results Generation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps the string entries of an array and never fails the parent parse.
 * `.optional()` matters: without it zod treats the transform as non-optional and
 * a payload that simply omits the key fails the whole object.
 */
const stringList = z
  .unknown()
  .optional()
  .transform((value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  );

/** Every field degrades independently, so a partial payload still renders. */
const urlReportSchema = z.object({
  status: z.string().catch(""),
  url: z.string().catch(""),
  title: z.string().catch(""),
  summary: z.string().catch(""),
  insights: stringList,
  sources: stringList,
  ai_enhanced: z.boolean().catch(false),
});

export type UrlReport = z.infer<typeof urlReportSchema>;

export interface UrlReportOutput {
  report: UrlReport | null;
  /** Wall-clock seconds reported by the worker, when present. */
  durationSeconds: number | null;
  /** Error text from a failed run, when the worker recorded one. */
  error: string | null;
}

function looksLikeReport(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.summary === "string";
}

/**
 * Finds the report payload inside a worker output envelope.
 *
 * The step key is the contract, so anything stored under it is accepted as the
 * report and left to per-field degradation. The two fallbacks — a renamed step,
 * or a bare report with no envelope — sniff for a report shape instead, which
 * keeps them from latching onto some unrelated step's result.
 */
function findReportPayload(output: unknown): Record<string, unknown> | null {
  if (!isRecord(output)) return null;

  const { results } = output;
  if (isRecord(results)) {
    const named = results[RESULT_STEP_KEY];
    if (isRecord(named)) return named;

    for (const value of Object.values(results)) {
      if (looksLikeReport(value)) return value;
    }
  }

  return looksLikeReport(output) ? output : null;
}

export function parseUrlReportOutput(output: unknown): UrlReportOutput {
  const payload = findReportPayload(output);
  const parsed = payload ? urlReportSchema.safeParse(payload) : null;

  const envelope = isRecord(output) ? output : {};
  const duration = envelope.duration_seconds;
  const error = envelope.error;

  return {
    report: parsed?.success ? parsed.data : null,
    durationSeconds: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
    error: typeof error === "string" && error.trim() ? error.trim() : null,
  };
}

/** The URL a job was submitted for, read back out of `jobs.input`. */
export function readJobInputUrl(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
}

/** The optional question a job was submitted with. */
export function readJobInputQuestion(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return typeof input.question === "string" && input.question.trim()
    ? input.question.trim()
    : null;
}
