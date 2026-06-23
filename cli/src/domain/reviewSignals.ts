import type { ReviewTextMode, ReviewsRecentInput } from "../schemas/cliInputs.js";
import {
  reviewSignalClassificationSchema,
  reviewSummarySchema,
  type ReleaseSummary,
  type ReviewSignal,
  type ReviewSignalClassification,
  type ReviewSummary,
  type ReviewTextOutput,
  type ReviewVersionCorrelation,
  type ReviewsRecentOutput
} from "../schemas/cliOutputs.js";
import type { PlayReview, PlayReviewUserComment, PlayTimestamp } from "../schemas/playApiTypes.js";

interface KeywordPattern {
  label: string;
  pattern: RegExp;
}

interface ReviewSummaryOptions {
  reviewText: ReviewTextMode;
  snippetLength?: number;
}

interface ReviewCorrelationSummaryInput {
  packageName: string;
  track: string;
  input: ReviewsRecentInput;
  matchedReviews: ReviewSummary[];
  returnedReviewCount: number;
  fetchedReviewCount: number;
  releases: ReleaseSummary[];
}

const DEFAULT_SNIPPET_LENGTH = 180;

const KEYWORD_PATTERNS: Record<ReviewSignal, KeywordPattern[]> = {
  crash: [
    { label: "crash", pattern: /\bcrash(?:e[sd]?|ing|es)?\b/i },
    { label: "force-close", pattern: /\bforce close[sd]?\b/i },
    { label: "closes-itself", pattern: /\b(?:close[sd]?|shuts?) (?:itself|down|off|immediately)\b/i },
    { label: "stops-working", pattern: /\bstops? working\b/i },
    { label: "fatal-exception", pattern: /\bfatal exception\b/i },
    { label: "runtime-exception", pattern: /\b(?:exception|runtimeexception|nullpointerexception|illegalstateexception)\b/i },
    { label: "native-crash", pattern: /\b(?:sigsegv|sigabrt|segfault)\b/i },
    { label: "se-cierra", pattern: /\bse cierra\b/i },
    { label: "absturz", pattern: /\b(?:absturz|stuerzt ab|sturzt ab)\b/i }
  ],
  freeze: [
    { label: "freeze", pattern: /\bfreez(?:e|es|ing)?\b/i },
    { label: "frozen", pattern: /\bfrozen\b/i },
    { label: "hang", pattern: /\bhang(?:s|ing)?\b/i },
    { label: "stuck", pattern: /\bstuck\b/i },
    { label: "locked-up", pattern: /\blocked up\b/i },
    { label: "unresponsive", pattern: /\bunresponsive\b/i },
    { label: "lag", pattern: /\b(?:lag|jank|stutter(?:s|ing)?)\b/i },
    { label: "bloquea", pattern: /\b(?:bloquea|congela)\b/i },
    { label: "friert-ein", pattern: /\bfriert ein\b/i }
  ],
  anr: [
    { label: "anr", pattern: /(^|[^a-z])anr([^a-z]|$)/i },
    { label: "application-not-responding", pattern: /\bapplication not responding\b/i },
    { label: "app-not-responding", pattern: /\bapp (?:is )?not responding\b/i },
    { label: "does-not-respond", pattern: /\bdoes(?: not|n't) respond\b/i }
  ]
};

export function summarizeReview(review: PlayReview, options: ReviewSummaryOptions): ReviewSummary | null {
  const userComment = latestUserComment(review);

  if (!userComment) {
    return null;
  }

  const lastModified = timestampToIso(userComment.lastModified);
  const textForDisplay = userComment.text ?? userComment.originalText ?? "";
  const classification = classifyReviewText([userComment.text, userComment.originalText]);

  return reviewSummarySchema.parse({
    reviewId: review.reviewId,
    lastModified,
    starRating: validStarRating(userComment.starRating) ? userComment.starRating : undefined,
    reviewerLanguage: emptyToUndefined(userComment.reviewerLanguage),
    versionCode: emptyToUndefined(userComment.appVersionCode),
    versionName: emptyToUndefined(userComment.appVersionName),
    androidOsVersion: userComment.androidOsVersion,
    device: {
      codename: emptyToUndefined(userComment.device),
      productName: emptyToUndefined(userComment.deviceMetadata?.productName),
      manufacturer: emptyToUndefined(userComment.deviceMetadata?.manufacturer),
      deviceClass: emptyToUndefined(userComment.deviceMetadata?.deviceClass)
    },
    thumbsUpCount: userComment.thumbsUpCount ?? 0,
    thumbsDownCount: userComment.thumbsDownCount ?? 0,
    signals: classification,
    text: formatReviewText(textForDisplay, options.reviewText, options.snippetLength ?? DEFAULT_SNIPPET_LENGTH)
  });
}

export function classifyReviewText(values: Array<string | undefined>): ReviewSignalClassification {
  const text = values.filter(Boolean).join("\n");
  const matches = Object.entries(KEYWORD_PATTERNS).map(([signal, patterns]) => {
    const matchedKeywords = patterns.filter((item) => item.pattern.test(text)).map((item) => item.label);

    return [signal as ReviewSignal, matchedKeywords] as const;
  });
  const signals = matches.flatMap(([signal, matchedKeywords]) => (matchedKeywords.length > 0 ? [signal] : []));
  const matchedKeywords = matches.flatMap(([, keywords]) => keywords);

  return reviewSignalClassificationSchema.parse({
    signals,
    crash: signals.includes("crash"),
    freeze: signals.includes("freeze"),
    anr: signals.includes("anr"),
    matchedKeywords
  });
}

export function formatReviewText(text: string, mode: ReviewTextMode, snippetLength = DEFAULT_SNIPPET_LENGTH): ReviewTextOutput {
  if (mode === "redacted") {
    return {
      mode,
      included: false,
      piiRedacted: false,
      truncated: false
    };
  }

  const sanitized = redactSensitiveText(text);
  const maxLength = Math.max(1, snippetLength);
  const truncated = mode === "snippet" && sanitized.length > maxLength;
  const value = truncated ? `${sanitized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : sanitized;

  return {
    mode,
    included: true,
    piiRedacted: sanitized !== normalizeText(text),
    truncated,
    value
  };
}

export function reviewMatchesRecentFilters(review: ReviewSummary, input: ReviewsRecentInput): boolean {
  if (!review.lastModified || !isWithinDateRange(review.lastModified, input.startDate, input.endDateExclusive)) {
    return false;
  }

  if (input.versionCodes.length > 0 && (!review.versionCode || !input.versionCodes.includes(review.versionCode))) {
    return false;
  }

  if (input.ratings.length > 0 && (!review.starRating || !input.ratings.includes(review.starRating))) {
    return false;
  }

  if (input.minRating && (!review.starRating || review.starRating < input.minRating)) {
    return false;
  }

  if (input.maxRating && (!review.starRating || review.starRating > input.maxRating)) {
    return false;
  }

  return true;
}

export function createReviewCorrelationSummary(
  params: ReviewCorrelationSummaryInput
): ReviewsRecentOutput["summary"] {
  const signalReviewCount = params.matchedReviews.filter(hasAnySignal).length;
  const signalCounts = signalCountMap(params.matchedReviews);
  const ratingValues = params.matchedReviews.flatMap((review) => (review.starRating ? [review.starRating] : []));
  const versionBreakdown = createVersionBreakdown(params.matchedReviews, params.input.versionCodes, params.releases);

  return {
    answer: reviewCorrelationAnswer(params.matchedReviews.length, signalReviewCount, signalCounts),
    fetchedReviewCount: params.fetchedReviewCount,
    matchedReviewCount: params.matchedReviews.length,
    returnedReviewCount: params.returnedReviewCount,
    signalReviewCount,
    crashCount: signalCounts.crash,
    freezeCount: signalCounts.freeze,
    anrCount: signalCounts.anr,
    lowRatingSignalReviewCount: params.matchedReviews.filter(
      (review) => hasAnySignal(review) && review.starRating !== undefined && review.starRating <= 2
    ).length,
    averageRating: averageOrNull(ratingValues),
    ratingDistribution: ratingDistribution(params.matchedReviews),
    versionBreakdown,
    topSignals: topSignals(signalCounts),
    nextActions: reviewCorrelationNextActions(params.packageName, params.track, params.input, versionBreakdown, signalReviewCount)
  };
}

export function releasesMatchingVersionCodes(releases: ReleaseSummary[], versionCodes: string[]): ReleaseSummary[] {
  if (versionCodes.length === 0) {
    return [];
  }

  const requested = new Set(versionCodes);

  return releases.filter((release) => release.versionCodes.some((versionCode) => requested.has(versionCode)));
}

export function timestampToIso(timestamp: PlayTimestamp | undefined): string | undefined {
  const seconds = Number(timestamp?.seconds);

  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  const millis = seconds * 1000 + Math.floor((timestamp?.nanos ?? 0) / 1_000_000);
  const date = new Date(millis);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function latestUserComment(review: PlayReview): PlayReviewUserComment | undefined {
  const userComments = review.comments.flatMap((comment) => (comment.userComment ? [comment.userComment] : []));

  return userComments.sort((left, right) => timestampMs(right.lastModified) - timestampMs(left.lastModified))[0];
}

function timestampMs(timestamp: PlayTimestamp | undefined): number {
  const iso = timestampToIso(timestamp);
  return iso ? Date.parse(iso) : 0;
}

function validStarRating(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function redactSensitiveText(text: string): string {
  return normalizeText(text)
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\bwww\.\S+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g, "[number]");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isWithinDateRange(isoTimestamp: string, startDate: string, endDateExclusive: string): boolean {
  const value = Date.parse(isoTimestamp);

  return value >= dateOnlyUtcMs(startDate) && value < dateOnlyUtcMs(endDateExclusive);
}

function dateOnlyUtcMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function hasAnySignal(review: ReviewSummary): boolean {
  return review.signals.signals.length > 0;
}

function signalCountMap(reviews: ReviewSummary[]): Record<ReviewSignal, number> {
  return {
    crash: reviews.filter((review) => review.signals.crash).length,
    freeze: reviews.filter((review) => review.signals.freeze).length,
    anr: reviews.filter((review) => review.signals.anr).length
  };
}

function ratingDistribution(reviews: ReviewSummary[]): Record<string, number> {
  const distribution: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
    unknown: 0
  };

  for (const review of reviews) {
    distribution[String(review.starRating ?? "unknown")] += 1;
  }

  return distribution;
}

function createVersionBreakdown(
  reviews: ReviewSummary[],
  requestedVersionCodes: string[],
  releases: ReleaseSummary[]
): ReviewVersionCorrelation[] {
  const releaseByVersion = releaseMapByVersion(releases);
  const observedVersionCodes = reviews.map((review) => review.versionCode ?? "unknown");
  const versionCodes = requestedVersionCodes.length > 0 ? requestedVersionCodes : sortedVersionCodes(dedupe(observedVersionCodes));

  return versionCodes.map((versionCode) => {
    const versionReviews = reviews.filter((review) => (review.versionCode ?? "unknown") === versionCode);
    const signalCounts = signalCountMap(versionReviews);
    const release = releaseByVersion.get(versionCode);

    return {
      versionCode,
      versionName: firstDefined(versionReviews.map((review) => review.versionName)),
      releaseName: release?.releaseName,
      status: release?.status,
      rolloutFraction: release?.rolloutFraction,
      reviewCount: versionReviews.length,
      signalReviewCount: versionReviews.filter(hasAnySignal).length,
      crashCount: signalCounts.crash,
      freezeCount: signalCounts.freeze,
      anrCount: signalCounts.anr,
      averageRating: averageOrNull(versionReviews.flatMap((review) => (review.starRating ? [review.starRating] : [])))
    };
  });
}

function releaseMapByVersion(releases: ReleaseSummary[]): Map<string, ReleaseSummary> {
  return new Map(releases.flatMap((release) => release.versionCodes.map((versionCode) => [versionCode, release] as const)));
}

function sortedVersionCodes(versionCodes: string[]): string[] {
  return [...versionCodes].sort((left, right) => {
    if (left === "unknown") {
      return 1;
    }

    if (right === "unknown") {
      return -1;
    }

    return Number(right) - Number(left) || left.localeCompare(right);
  });
}

function reviewCorrelationAnswer(
  matchedReviewCount: number,
  signalReviewCount: number,
  signalCounts: Record<ReviewSignal, number>
): string {
  if (matchedReviewCount === 0) {
    return "No recent reviews matched the requested date, version-code, and rating filters.";
  }

  if (signalReviewCount === 0) {
    return `No crash, freeze, or ANR keyword complaints were found among ${matchedReviewCount} matched review(s).`;
  }

  return [
    `${signalReviewCount} of ${matchedReviewCount} matched review(s) mention crash, freeze, or ANR keywords`,
    `crash=${signalCounts.crash}`,
    `freeze=${signalCounts.freeze}`,
    `ANR=${signalCounts.anr}`
  ].join("; ") + ".";
}

function reviewCorrelationNextActions(
  packageName: string,
  track: string,
  input: ReviewsRecentInput,
  versionBreakdown: ReviewVersionCorrelation[],
  signalReviewCount: number
): string[] {
  if (signalReviewCount === 0) {
    return ["Continue normal review and release-health monitoring for the requested filters."];
  }

  const versionCodes = versionBreakdown
    .filter((entry) => entry.versionCode !== "unknown" && entry.signalReviewCount > 0)
    .map((entry) => entry.versionCode);
  const versionArg = (versionCodes.length > 0 ? versionCodes : input.versionCodes).join(",");

  if (!versionArg) {
    return ["Review crash/freeze/ANR complaint examples and rerun with a version-code filter when version metadata is available."];
  }

  return [
    `Compare crash/ANR health for the complaint versions: scripts/playstore health release --package ${packageName} --track ${track} --version-code ${versionArg} --start-date ${input.startDate} --end-date ${input.endDateExclusive} --format markdown`,
    `List crash/ANR issues for the complaint versions: scripts/playstore issues list --package ${packageName} --version-code ${versionArg} --start-date ${input.startDate} --end-date ${input.endDateExclusive} --format markdown`
  ];
}

function topSignals(signalCounts: Record<ReviewSignal, number>): ReviewSignal[] {
  return (Object.entries(signalCounts) as Array<[ReviewSignal, number]>)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([signal]) => signal);
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function firstDefined<TValue>(values: Array<TValue | undefined>): TValue | undefined {
  return values.find((value) => value !== undefined);
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}
