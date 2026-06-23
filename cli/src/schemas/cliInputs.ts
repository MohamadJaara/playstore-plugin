import { z } from "zod";

export const outputFormatSchema = z.enum(["json", "markdown"]);

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidDateOnly, "Expected a valid calendar date in YYYY-MM-DD format.");

export const appsListInputSchema = z.object({
  format: outputFormatSchema.default("json")
});

export const releasesListInputSchema = z.object({
  packageName: z.string().trim().min(1).optional(),
  track: z.string().trim().min(1).default("production"),
  latest: z.boolean().default(false),
  format: outputFormatSchema.default("json")
});

export const healthDimensionSchema = z.enum(["apiLevel", "deviceModel", "countryCode", "versionCode"]);

export const healthReleaseInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    track: z.string().trim().min(1).default("production"),
    versionCodes: z.array(z.string().trim().regex(/^\d+$/)).min(1),
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    dimensions: z.array(healthDimensionSchema).default([]),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  });

const versionCodesSchema = z.array(z.string().trim().regex(/^\d+$/)).min(1);

export const issueTypeFilterSchema = z.enum(["all", "crash", "anr"]);

export const issueStateFilterSchema = z.enum(["all", "open", "unknown"]);

export const issuesListInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    versionCodes: versionCodesSchema,
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    type: issueTypeFilterSchema.default("all"),
    state: issueStateFilterSchema.default("all"),
    limit: z.number().int().positive().max(1000).default(20),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  });

export const reportsListInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    issueId: z.string().trim().min(1),
    versionCodes: z.array(z.string().trim().regex(/^\d+$/)).default([]),
    startDate: dateOnlySchema.optional(),
    endDateExclusive: dateOnlySchema.optional(),
    type: issueTypeFilterSchema.default("all"),
    limit: z.number().int().positive().max(100).default(10),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => !input.startDate || !input.endDateExclusive || input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  })
  .refine((input) => Boolean(input.startDate) === Boolean(input.endDateExclusive), {
    message: "startDate and endDateExclusive must be provided together.",
    path: ["endDateExclusive"]
  });

export const compareReleasesInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    track: z.string().trim().min(1).default("production"),
    currentVersionCodes: versionCodesSchema,
    previousVersionCodes: versionCodesSchema,
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    type: issueTypeFilterSchema.default("all"),
    limit: z.number().int().positive().max(1000).default(20),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  });

export const triageStacktraceInputSchema = z.object({
  stackTrace: z.string(),
  sourceRoot: z.string().trim().min(1).default("."),
  maxFiles: z.number().int().positive().max(100).default(10),
  git: z.boolean().default(false),
  format: outputFormatSchema.default("json")
});

export const reviewTextModeSchema = z.enum(["redacted", "snippet", "full"]);

const starRatingSchema = z.number().int().min(1).max(5);

export const reviewsRecentInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    track: z.string().trim().min(1).default("production"),
    versionCodes: z.array(z.string().trim().regex(/^\d+$/)).default([]),
    ratings: z.array(starRatingSchema).default([]),
    minRating: starRatingSchema.optional(),
    maxRating: starRatingSchema.optional(),
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    limit: z.number().int().positive().max(1000).default(20),
    fetchLimit: z.number().int().positive().max(1000).default(200),
    translationLanguage: z.string().trim().min(1).optional(),
    reviewText: reviewTextModeSchema.default("redacted"),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  })
  .refine((input) => !input.minRating || !input.maxRating || input.minRating <= input.maxRating, {
    message: "minRating must be less than or equal to maxRating.",
    path: ["maxRating"]
  });

export const anomalySignalFilterSchema = z.enum(["all", "crash", "anr"]);

export const anomaliesListInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    versionCodes: z.array(z.string().trim().regex(/^\d+$/)).default([]),
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    signal: anomalySignalFilterSchema.default("all"),
    limit: z.number().int().positive().max(1000).default(20),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  });

export const reportRolloutRiskInputSchema = z
  .object({
    packageName: z.string().trim().min(1).optional(),
    track: z.string().trim().min(1).default("production"),
    versionCodes: versionCodesSchema,
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    issueLimit: z.number().int().positive().max(1000).default(10),
    anomalyLimit: z.number().int().positive().max(1000).default(20),
    reviewLimit: z.number().int().positive().max(1000).default(20),
    reviewFetchLimit: z.number().int().positive().max(1000).default(200),
    maxRating: starRatingSchema.default(2),
    format: outputFormatSchema.default("json")
  })
  .refine((input) => input.startDate < input.endDateExclusive, {
    message: "startDate must be before endDateExclusive.",
    path: ["endDateExclusive"]
  });

export type AppsListInput = z.infer<typeof appsListInputSchema>;
export type ReleasesListInput = z.infer<typeof releasesListInputSchema>;
export type HealthDimension = z.infer<typeof healthDimensionSchema>;
export type HealthReleaseInput = z.infer<typeof healthReleaseInputSchema>;
export type IssueTypeFilter = z.infer<typeof issueTypeFilterSchema>;
export type IssueStateFilter = z.infer<typeof issueStateFilterSchema>;
export type IssuesListInput = z.infer<typeof issuesListInputSchema>;
export type ReportsListInput = z.infer<typeof reportsListInputSchema>;
export type CompareReleasesInput = z.infer<typeof compareReleasesInputSchema>;
export type TriageStacktraceInput = z.infer<typeof triageStacktraceInputSchema>;
export type ReviewTextMode = z.infer<typeof reviewTextModeSchema>;
export type ReviewsRecentInput = z.infer<typeof reviewsRecentInputSchema>;
export type AnomalySignalFilter = z.infer<typeof anomalySignalFilterSchema>;
export type AnomaliesListInput = z.infer<typeof anomaliesListInputSchema>;
export type ReportRolloutRiskInput = z.infer<typeof reportRolloutRiskInputSchema>;

function isValidDateOnly(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
