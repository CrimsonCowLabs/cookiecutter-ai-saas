"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitJob } from "@/app/actions/jobs";
import { URL_REPORT_JOB_TYPE } from "@/lib/url-report";
import { MAX_QUESTION_LENGTH, MAX_URL_LENGTH, urlReportInputSchema } from "@/lib/validations";

export function NewJobForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = urlReportInputSchema.safeParse({
      url,
      question: question.trim() || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form and try again");
      return;
    }

    startTransition(async () => {
      const result = await submitJob(URL_REPORT_JOB_TYPE, parsed.data);

      if (!result.success) {
        setError(result.error);
        return;
      }

      if (!result.data?.jobId) {
        setError("Job was submitted but no id came back. Check Recent Jobs below.");
        return;
      }

      setUrl("");
      setQuestion("");
      router.push(`/dashboard/jobs/${result.data.jobId}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="bg-base-200 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">New report</h2>
        <p className="text-sm text-base-content/60 mt-1">
          Give us a page to read. We&apos;ll fetch it, summarize it, and pull out the
          key takeaways.
        </p>
      </div>

      <label className="flex flex-col">
        <span className="mb-2 block text-sm font-semibold text-base-content/80">URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          inputMode="url"
          required
          maxLength={MAX_URL_LENGTH}
          placeholder="https://example.com/article"
          className="input w-full"
          disabled={isPending}
        />
      </label>

      <label className="flex flex-col">
        <span className="mb-2 block text-sm font-semibold text-base-content/80">
          Question <span className="font-normal text-base-content/50">(optional)</span>
        </span>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="What should we focus on? e.g. How does their pricing work?"
          className="textarea w-full"
          disabled={isPending}
        />
      </label>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      )}

      <button type="submit" className="btn btn-primary" disabled={isPending}>
        {isPending ? (
          <>
            <span className="loading loading-spinner loading-sm" />
            Submitting...
          </>
        ) : (
          "Generate report"
        )}
      </button>
    </form>
  );
}
