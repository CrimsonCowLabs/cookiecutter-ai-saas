import { z } from "zod";
import { isHttpUrl } from "@/lib/url";

export const emailSchema = z
  .email("Invalid email address")
  .min(3, "Email is too short")
  .max(320, "Email is too long");

// ─── Job inputs ──────────────────────────────────────────

export const MAX_URL_LENGTH = 2048;
export const MAX_QUESTION_LENGTH = 500;

/** Input for the `url-report` job: fetch a page and report on it. */
export const urlReportInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Enter a URL to analyze")
    .max(MAX_URL_LENGTH, `URL must be ${MAX_URL_LENGTH} characters or fewer`)
    .refine(isHttpUrl, "Enter a full http(s) URL, e.g. https://example.com/article"),
  question: z
    .string()
    .trim()
    .max(MAX_QUESTION_LENGTH, `Question must be ${MAX_QUESTION_LENGTH} characters or fewer`)
    .optional(),
});

export type UrlReportInput = z.infer<typeof urlReportInputSchema>;

/**
 * Input schemas enforced server-side by `submitJob`, keyed by job type. Add an
 * entry here when you add a job type — types without one are dispatched with
 * their input unvalidated.
 */
export const jobInputSchemas = {
  "url-report": urlReportInputSchema,
} satisfies Record<string, z.ZodType>;

export type ValidatedJobType = keyof typeof jobInputSchemas;

export function getJobInputSchema(type: string): z.ZodType | undefined {
  return Object.hasOwn(jobInputSchemas, type)
    ? jobInputSchemas[type as ValidatedJobType]
    : undefined;
}

export const contactTypes = ["support", "feedback"] as const;

export const contactSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name is too long"),
  email: z.email("Invalid email address").trim().max(254, "Email is too long"),
  type: z.enum(contactTypes),
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(160, "Subject is too long"),
  message: z.string().trim().min(20, "Message must be at least 20 characters").max(5000, "Message is too long"),
});

export type ContactInput = z.infer<typeof contactSchema>;
