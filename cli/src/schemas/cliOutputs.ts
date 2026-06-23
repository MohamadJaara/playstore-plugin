import { z } from "zod";

export const appSummarySchema = z.object({
  packageName: z.string().min(1)
});

export const appsListOutputSchema = z.object({
  apps: z.array(appSummarySchema)
});

export const releaseSummarySchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  versionCodes: z.array(z.string()),
  releaseName: z.string().optional(),
  status: z.string().optional(),
  rolloutFraction: z.number().min(0).max(1).optional()
});

export const releasesListOutputSchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  releases: z.array(releaseSummarySchema),
  latest: releaseSummarySchema.optional()
});

export const releaseHealthSignalSchema = z.enum(["crash", "anr"]);

export const releaseHealthRateSummarySchema = z.object({
  value: z.number().nullable(),
  unit: z.literal("ratio"),
  aggregation: z.enum(["distinctUsersWeightedAverage", "arithmeticMean", "unavailable"]),
  dataPoints: z.number().int().nonnegative(),
  missingPoints: z.number().int().nonnegative()
});

export const releaseHealthDistinctUsersSummarySchema = z.object({
  userDays: z.number().nullable(),
  dataPoints: z.number().int().nonnegative(),
  missingPoints: z.number().int().nonnegative(),
  note: z.string()
});

export const releaseHealthMetricSummarySchema = z.object({
  rate: releaseHealthRateSummarySchema,
  userPerceivedRate: releaseHealthRateSummarySchema,
  distinctUsers: releaseHealthDistinctUsersSummarySchema
});

export const releaseHealthSeriesPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  versionCode: z.string().min(1),
  dimensions: z.record(z.string(), z.string()),
  metrics: z.record(z.string(), z.number().nullable()),
  missingMetrics: z.array(z.string())
});

export const releaseHealthSliceSchema = z.object({
  dimensions: z.record(z.string(), z.string()),
  summary: releaseHealthMetricSummarySchema,
  dataPoints: z.number().int().nonnegative()
});

export const releaseHealthMetricGroupSchema = z.object({
  signal: releaseHealthSignalSchema,
  metricSet: z.string().min(1),
  metricNames: z.object({
    rate: z.string().min(1),
    userPerceivedRate: z.string().min(1),
    distinctUsers: z.literal("distinctUsers")
  }),
  summary: releaseHealthMetricSummarySchema,
  series: z.array(releaseHealthSeriesPointSchema),
  slices: z.array(releaseHealthSliceSchema),
  missingData: z.object({
    rows: z.number().int().nonnegative(),
    rowsMissingAnyMetric: z.number().int().nonnegative(),
    metrics: z.record(z.string(), z.number().int().nonnegative())
  })
});

export const releaseHealthOutputSchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  versionCodes: z.array(z.string().min(1)).min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive(),
    aggregationPeriod: z.literal("DAILY"),
    timeZone: z.literal("America/Los_Angeles")
  }),
  dimensions: z.array(z.string()),
  metricGroups: z.array(releaseHealthMetricGroupSchema),
  warnings: z.array(z.string())
});

export const issueStateSchema = z.enum(["open", "unknown"]);

export const issueTypeOutputSchema = z.enum(["crash", "anr", "non_fatal", "unknown"]);

export const issueSummarySchema = z.object({
  issueId: z.string().min(1),
  name: z.string().min(1),
  type: issueTypeOutputSchema,
  state: issueStateSchema,
  cause: z.string().optional(),
  location: z.string().optional(),
  firstAppVersion: z.string().optional(),
  lastAppVersion: z.string().optional(),
  firstOsVersion: z.string().optional(),
  lastOsVersion: z.string().optional(),
  lastErrorReportTime: z.string().optional(),
  sampleErrorReports: z.array(z.string()),
  issueUri: z.string().optional(),
  current: z.object({
    affectedUsers: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    affectedUsersPercent: z.number().nullable()
  }),
  previous: z.object({
    affectedUsers: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative()
  }),
  growth: z.object({
    affectedUsersDelta: z.number().int(),
    eventCountDelta: z.number().int(),
    affectedUsersRatio: z.number().nullable(),
    eventCountRatio: z.number().nullable()
  }),
  impact: z.object({
    userPerceived: z.boolean(),
    userPerceivedAffectedUsers: z.number().int().nonnegative(),
    userPerceivedEventCount: z.number().int().nonnegative(),
    recencyDays: z.number().nullable()
  }),
  rank: z.object({
    position: z.number().int().positive(),
    score: z.number().nonnegative(),
    factors: z.object({
      affectedUsers: z.number().min(0).max(1),
      eventCount: z.number().min(0).max(1),
      growth: z.number().min(0).max(1),
      recency: z.number().min(0).max(1),
      userPerceived: z.number().min(0).max(1)
    })
  })
});

export const issuesListOutputSchema = z.object({
  packageName: z.string().min(1),
  versionCodes: z.array(z.string().min(1)).min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive(),
    previousStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    previousEndDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: z.literal("America/Los_Angeles")
  }),
  filters: z.object({
    type: z.enum(["all", "crash", "anr"]),
    state: z.enum(["all", "open", "unknown"]),
    limit: z.number().int().positive()
  }),
  issues: z.array(issueSummarySchema),
  warnings: z.array(z.string())
});

export const stackTraceFrameSchema = z.object({
  raw: z.string().min(1),
  declaringClass: z.string().optional(),
  method: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  native: z.boolean().optional(),
  unknownSource: z.boolean().optional()
});

export const stackTraceExtractionSchema = z.object({
  exceptionType: z.string().optional(),
  exceptionMessage: z.string().optional(),
  signal: z.string().optional(),
  thread: z.string().optional(),
  frames: z.array(stackTraceFrameSchema),
  rawTopFrame: z.string().optional(),
  malformedLines: z.array(z.string()),
  truncated: z.boolean()
});

export const errorReportSummarySchema = z.object({
  reportId: z.string().min(1),
  name: z.string().min(1),
  issueId: z.string().optional(),
  issue: z.string().optional(),
  type: issueTypeOutputSchema,
  versionCode: z.string().optional(),
  apiLevel: z.string().optional(),
  device: z.object({
    marketingName: z.string().optional(),
    brand: z.string().optional(),
    device: z.string().optional(),
    uri: z.string().optional()
  }),
  eventTime: z.string().optional(),
  vcsInformation: z.string().optional(),
  stackTrace: stackTraceExtractionSchema
});

export const reportsListOutputSchema = z.object({
  packageName: z.string().min(1),
  issueId: z.string().min(1),
  dateRange: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      days: z.number().int().positive(),
      timeZone: z.literal("America/Los_Angeles")
    })
    .optional(),
  filters: z.object({
    type: z.enum(["all", "crash", "anr"]),
    versionCodes: z.array(z.string()),
    limit: z.number().int().positive()
  }),
  reports: z.array(errorReportSummarySchema),
  warnings: z.array(z.string())
});

export const reviewSignalSchema = z.enum(["crash", "freeze", "anr"]);

export const reviewSignalClassificationSchema = z.object({
  signals: z.array(reviewSignalSchema),
  crash: z.boolean(),
  freeze: z.boolean(),
  anr: z.boolean(),
  matchedKeywords: z.array(z.string())
});

export const reviewTextOutputSchema = z.object({
  mode: z.enum(["redacted", "snippet", "full"]),
  included: z.boolean(),
  piiRedacted: z.boolean(),
  truncated: z.boolean(),
  value: z.string().optional()
});

export const reviewSummarySchema = z.object({
  reviewId: z.string().min(1),
  lastModified: z.string().optional(),
  starRating: z.number().int().min(1).max(5).optional(),
  reviewerLanguage: z.string().optional(),
  versionCode: z.string().optional(),
  versionName: z.string().optional(),
  androidOsVersion: z.number().int().optional(),
  device: z.object({
    codename: z.string().optional(),
    productName: z.string().optional(),
    manufacturer: z.string().optional(),
    deviceClass: z.string().optional()
  }),
  thumbsUpCount: z.number().int().nonnegative(),
  thumbsDownCount: z.number().int().nonnegative(),
  signals: reviewSignalClassificationSchema,
  text: reviewTextOutputSchema
});

export const reviewVersionCorrelationSchema = z.object({
  versionCode: z.string().min(1),
  versionName: z.string().optional(),
  releaseName: z.string().optional(),
  status: z.string().optional(),
  rolloutFraction: z.number().min(0).max(1).optional(),
  reviewCount: z.number().int().nonnegative(),
  signalReviewCount: z.number().int().nonnegative(),
  crashCount: z.number().int().nonnegative(),
  freezeCount: z.number().int().nonnegative(),
  anrCount: z.number().int().nonnegative(),
  averageRating: z.number().nullable()
});

export const reviewsRecentOutputSchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive(),
    timeZone: z.literal("UTC")
  }),
  filters: z.object({
    versionCodes: z.array(z.string()),
    ratings: z.array(z.number().int().min(1).max(5)),
    minRating: z.number().int().min(1).max(5).optional(),
    maxRating: z.number().int().min(1).max(5).optional(),
    limit: z.number().int().positive(),
    fetchLimit: z.number().int().positive(),
    translationLanguage: z.string().optional(),
    reviewText: z.enum(["redacted", "snippet", "full"])
  }),
  releaseContext: z.object({
    latest: releaseSummarySchema.optional(),
    matchedReleases: z.array(releaseSummarySchema)
  }),
  summary: z.object({
    answer: z.string().min(1),
    fetchedReviewCount: z.number().int().nonnegative(),
    matchedReviewCount: z.number().int().nonnegative(),
    returnedReviewCount: z.number().int().nonnegative(),
    signalReviewCount: z.number().int().nonnegative(),
    crashCount: z.number().int().nonnegative(),
    freezeCount: z.number().int().nonnegative(),
    anrCount: z.number().int().nonnegative(),
    lowRatingSignalReviewCount: z.number().int().nonnegative(),
    averageRating: z.number().nullable(),
    ratingDistribution: z.record(z.string(), z.number().int().nonnegative()),
    versionBreakdown: z.array(reviewVersionCorrelationSchema),
    topSignals: z.array(reviewSignalSchema),
    nextActions: z.array(z.string())
  }),
  reviews: z.array(reviewSummarySchema),
  warnings: z.array(z.string())
});

export const anomalySignalSchema = z.enum(["crash", "anr", "unknown"]);

export const anomalyMetricValueSchema = z.object({
  name: z.string().min(1),
  value: z.number().nullable(),
  confidenceInterval: z
    .object({
      lowerBound: z.number().nullable(),
      upperBound: z.number().nullable()
    })
    .optional()
});

export const anomalyTimelineSchema = z.object({
  aggregationPeriod: z.string().optional(),
  startTime: z.string().optional(),
  endTimeExclusive: z.string().optional(),
  timeZone: z.string().optional()
});

export const anomalySummarySchema = z.object({
  anomalyId: z.string().min(1),
  name: z.string().min(1),
  signal: anomalySignalSchema,
  metricSet: z.string().optional(),
  timeline: anomalyTimelineSchema,
  metric: anomalyMetricValueSchema.optional(),
  dimensions: z.record(z.string(), z.string()),
  dimensionLabels: z.record(z.string(), z.string()),
  versionCodes: z.array(z.string())
});

export const anomaliesListOutputSchema = z.object({
  packageName: z.string().min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive(),
    filterTimeZone: z.literal("America/Los_Angeles")
  }),
  filters: z.object({
    versionCodes: z.array(z.string()),
    signal: z.enum(["all", "crash", "anr"]),
    limit: z.number().int().positive()
  }),
  anomalies: z.array(anomalySummarySchema),
  warnings: z.array(z.string())
});

export const rolloutRiskRecommendationCategorySchema = z.enum([
  "continue monitoring",
  "investigate before increasing rollout",
  "manually halt rollout outside the plugin"
]);

export const rolloutRiskRecommendationSchema = z.object({
  category: rolloutRiskRecommendationCategorySchema,
  score: z.number().int().min(0).max(100),
  maxScore: z.literal(100),
  basis: z.literal("inferred recommendation from measured Play Console facts"),
  reasons: z.array(z.string()),
  nextActions: z.array(z.string()),
  readOnlyNotice: z.string().min(1)
});

export const rolloutRiskReportOutputSchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  versionCodes: z.array(z.string().min(1)).min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive()
  }),
  facts: z.object({
    health: releaseHealthOutputSchema,
    topIssues: issuesListOutputSchema,
    anomalies: anomaliesListOutputSchema,
    reviews: reviewsRecentOutputSchema
  }),
  recommendation: rolloutRiskRecommendationSchema,
  warnings: z.array(z.string())
});

export const regressionSeveritySchema = z.enum(["monitor", "investigate", "high-risk"]);

export const releaseMetricDeltaValueSchema = z.object({
  current: z.number().nullable(),
  previous: z.number().nullable(),
  absoluteDelta: z.number().nullable(),
  relativeRatio: z.number().nullable(),
  worsened: z.boolean()
});

export const releaseMetricRegressionSchema = z.object({
  signal: releaseHealthSignalSchema,
  severity: regressionSeveritySchema,
  current: z.object({
    rate: z.number().nullable(),
    userPerceivedRate: z.number().nullable(),
    distinctUserDays: z.number().nullable(),
    dataPoints: z.number().int().nonnegative()
  }),
  previous: z.object({
    rate: z.number().nullable(),
    userPerceivedRate: z.number().nullable(),
    distinctUserDays: z.number().nullable(),
    dataPoints: z.number().int().nonnegative()
  }),
  deltas: z.object({
    rate: releaseMetricDeltaValueSchema,
    userPerceivedRate: releaseMetricDeltaValueSchema,
    distinctUserDays: releaseMetricDeltaValueSchema
  }),
  reasons: z.array(z.string()),
  nextActions: z.array(z.string())
});

export const regressionIssueClassificationSchema = z.enum(["new", "resurfaced", "worsened", "fixed"]);

export const regressionIssueSnapshotSchema = z.object({
  affectedUsers: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  affectedUsersPercent: z.number().nullable(),
  userPerceivedAffectedUsers: z.number().int().nonnegative(),
  userPerceivedEventCount: z.number().int().nonnegative(),
  lastErrorReportTime: z.string().optional()
});

export const regressionIssueChangeSchema = z.object({
  issueId: z.string().min(1),
  name: z.string().min(1),
  type: issueTypeOutputSchema,
  classification: regressionIssueClassificationSchema,
  severity: regressionSeveritySchema,
  cause: z.string().optional(),
  location: z.string().optional(),
  firstAppVersion: z.string().optional(),
  lastAppVersion: z.string().optional(),
  lastErrorReportTime: z.string().optional(),
  sampleErrorReports: z.array(z.string()),
  issueUri: z.string().optional(),
  current: regressionIssueSnapshotSchema,
  previous: regressionIssueSnapshotSchema,
  historical: regressionIssueSnapshotSchema.optional(),
  deltas: z.object({
    affectedUsersDelta: z.number().int(),
    eventCountDelta: z.number().int(),
    affectedUsersRatio: z.number().nullable(),
    eventCountRatio: z.number().nullable()
  }),
  reasons: z.array(z.string()),
  nextActions: z.array(z.string())
});

export const compareReleasesOutputSchema = z.object({
  packageName: z.string().min(1),
  track: z.string().min(1),
  currentVersionCodes: z.array(z.string().min(1)).min(1),
  previousVersionCodes: z.array(z.string().min(1)).min(1),
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().positive(),
    previousStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    previousEndDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    aggregationPeriod: z.literal("DAILY"),
    timeZone: z.literal("America/Los_Angeles")
  }),
  filters: z.object({
    type: z.enum(["all", "crash", "anr"]),
    limit: z.number().int().positive()
  }),
  metrics: z.array(releaseMetricRegressionSchema),
  issues: z.object({
    newIssues: z.array(regressionIssueChangeSchema),
    resurfacedIssues: z.array(regressionIssueChangeSchema),
    worsenedIssues: z.array(regressionIssueChangeSchema),
    fixedIssues: z.array(regressionIssueChangeSchema),
    unchangedCount: z.number().int().nonnegative(),
    lowVolumeMonitorCount: z.number().int().nonnegative()
  }),
  summary: z.object({
    answer: z.string(),
    highestSeverity: regressionSeveritySchema,
    regressionCount: z.number().int().nonnegative(),
    metricRegressionCount: z.number().int().nonnegative(),
    fixedCount: z.number().int().nonnegative(),
    highRiskCount: z.number().int().nonnegative(),
    investigateCount: z.number().int().nonnegative(),
    monitorCount: z.number().int().nonnegative(),
    nextActions: z.array(z.string())
  }),
  warnings: z.array(z.string())
});

export const stackTraceTriageConfidenceSchema = z.enum(["high", "medium", "low"]);

export const stackTraceTriageMatchSchema = z.enum([
  "class-and-method",
  "class",
  "file-and-method",
  "file",
  "method",
  "obfuscated-file-hint"
]);

export const stackTraceTriageFrameCandidateSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  line: z.number().int().positive().optional(),
  match: stackTraceTriageMatchSchema,
  confidence: stackTraceTriageConfidenceSchema,
  score: z.number().nonnegative(),
  reasons: z.array(z.string())
});

export const stackTraceTriageFrameSchema = stackTraceFrameSchema.extend({
  index: z.number().int().nonnegative(),
  obfuscated: z.boolean(),
  candidates: z.array(stackTraceTriageFrameCandidateSchema)
});

export const stackTraceTriageCommitHintSchema = z.object({
  hash: z.string().min(1),
  authorName: z.string().optional(),
  date: z.string().optional(),
  subject: z.string().optional()
});

export const stackTraceTriageBlameHintSchema = stackTraceTriageCommitHintSchema.extend({
  line: z.number().int().positive()
});

export const stackTraceTriageFileMatchSchema = z.object({
  frameIndex: z.number().int().nonnegative(),
  rawFrame: z.string().min(1),
  line: z.number().int().positive().optional(),
  match: stackTraceTriageMatchSchema,
  confidence: stackTraceTriageConfidenceSchema,
  reasons: z.array(z.string())
});

export const stackTraceTriageSuspectFileSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  score: z.number().nonnegative(),
  confidence: stackTraceTriageConfidenceSchema,
  reasons: z.array(z.string()),
  frameMatches: z.array(stackTraceTriageFileMatchSchema),
  git: z
    .object({
      lastCommit: stackTraceTriageCommitHintSchema.optional(),
      blame: stackTraceTriageBlameHintSchema.optional()
    })
    .optional()
});

export const triageStacktraceOutputSchema = z.object({
  sourceRoot: z.string().min(1),
  stackTrace: stackTraceExtractionSchema,
  frames: z.array(stackTraceTriageFrameSchema),
  suspectFiles: z.array(stackTraceTriageSuspectFileSchema),
  summary: z.object({
    answer: z.string().min(1),
    confidence: stackTraceTriageConfidenceSchema,
    matchedFrameCount: z.number().int().nonnegative(),
    unmatchedFrameCount: z.number().int().nonnegative(),
    obfuscatedFrameCount: z.number().int().nonnegative(),
    suspectFileCount: z.number().int().nonnegative(),
    nextActions: z.array(z.string())
  }),
  warnings: z.array(z.string())
});

export type AppSummary = z.infer<typeof appSummarySchema>;
export type AppsListOutput = z.infer<typeof appsListOutputSchema>;
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;
export type ReleasesListOutput = z.infer<typeof releasesListOutputSchema>;
export type ReleaseHealthRateSummary = z.infer<typeof releaseHealthRateSummarySchema>;
export type ReleaseHealthDistinctUsersSummary = z.infer<typeof releaseHealthDistinctUsersSummarySchema>;
export type ReleaseHealthMetricSummary = z.infer<typeof releaseHealthMetricSummarySchema>;
export type ReleaseHealthSeriesPoint = z.infer<typeof releaseHealthSeriesPointSchema>;
export type ReleaseHealthMetricGroup = z.infer<typeof releaseHealthMetricGroupSchema>;
export type ReleaseHealthOutput = z.infer<typeof releaseHealthOutputSchema>;
export type IssueState = z.infer<typeof issueStateSchema>;
export type IssueSummary = z.infer<typeof issueSummarySchema>;
export type IssuesListOutput = z.infer<typeof issuesListOutputSchema>;
export type StackTraceFrame = z.infer<typeof stackTraceFrameSchema>;
export type StackTraceExtraction = z.infer<typeof stackTraceExtractionSchema>;
export type ErrorReportSummary = z.infer<typeof errorReportSummarySchema>;
export type ReportsListOutput = z.infer<typeof reportsListOutputSchema>;
export type ReviewSignal = z.infer<typeof reviewSignalSchema>;
export type ReviewSignalClassification = z.infer<typeof reviewSignalClassificationSchema>;
export type ReviewTextOutput = z.infer<typeof reviewTextOutputSchema>;
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export type ReviewVersionCorrelation = z.infer<typeof reviewVersionCorrelationSchema>;
export type ReviewsRecentOutput = z.infer<typeof reviewsRecentOutputSchema>;
export type AnomalySignal = z.infer<typeof anomalySignalSchema>;
export type AnomalyMetricValue = z.infer<typeof anomalyMetricValueSchema>;
export type AnomalyTimeline = z.infer<typeof anomalyTimelineSchema>;
export type AnomalySummary = z.infer<typeof anomalySummarySchema>;
export type AnomaliesListOutput = z.infer<typeof anomaliesListOutputSchema>;
export type RolloutRiskRecommendationCategory = z.infer<typeof rolloutRiskRecommendationCategorySchema>;
export type RolloutRiskRecommendation = z.infer<typeof rolloutRiskRecommendationSchema>;
export type RolloutRiskReportOutput = z.infer<typeof rolloutRiskReportOutputSchema>;
export type RegressionSeverity = z.infer<typeof regressionSeveritySchema>;
export type ReleaseMetricRegression = z.infer<typeof releaseMetricRegressionSchema>;
export type RegressionIssueClassification = z.infer<typeof regressionIssueClassificationSchema>;
export type RegressionIssueSnapshot = z.infer<typeof regressionIssueSnapshotSchema>;
export type RegressionIssueChange = z.infer<typeof regressionIssueChangeSchema>;
export type CompareReleasesOutput = z.infer<typeof compareReleasesOutputSchema>;
export type StackTraceTriageConfidence = z.infer<typeof stackTraceTriageConfidenceSchema>;
export type StackTraceTriageMatch = z.infer<typeof stackTraceTriageMatchSchema>;
export type StackTraceTriageFrameCandidate = z.infer<typeof stackTraceTriageFrameCandidateSchema>;
export type StackTraceTriageFrame = z.infer<typeof stackTraceTriageFrameSchema>;
export type StackTraceTriageCommitHint = z.infer<typeof stackTraceTriageCommitHintSchema>;
export type StackTraceTriageBlameHint = z.infer<typeof stackTraceTriageBlameHintSchema>;
export type StackTraceTriageSuspectFile = z.infer<typeof stackTraceTriageSuspectFileSchema>;
export type TriageStacktraceOutput = z.infer<typeof triageStacktraceOutputSchema>;
