import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayPublisherClient, type PlayPublisherClient } from "../clients/playPublisherClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { selectLatestRelease, summarizeRelease } from "../domain/releases.js";
import {
  createReviewCorrelationSummary,
  releasesMatchingVersionCodes,
  reviewMatchesRecentFilters,
  summarizeReview
} from "../domain/reviewSignals.js";
import {
  reviewTextModeSchema,
  reviewsRecentInputSchema,
  type ReviewTextMode,
  type ReviewsRecentInput
} from "../schemas/cliInputs.js";
import { reviewsRecentOutputSchema, type ReviewSummary, type ReviewsRecentOutput } from "../schemas/cliOutputs.js";
import type { PlayReview } from "../schemas/playApiTypes.js";
import { addDays, dateRangeDays, parsePositiveInteger } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { escapeMarkdownTableCell } from "../utils/markdown.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface ReviewsRecentOptions {
  package?: string;
  track: string;
  versionCode?: string[];
  rating?: string[];
  minRating?: number;
  maxRating?: number;
  days: number;
  endDate?: string;
  limit: number;
  fetchLimit: number;
  translationLanguage?: string;
  reviewText: string;
  format: string;
}

interface FetchReviewsResult {
  reviews: PlayReview[];
  capped: boolean;
}

const REVIEW_TIME_ZONE = "UTC";
const REVIEW_PAGE_SIZE = 100;

export function createReviewsCommand(): Command {
  const command = new Command("reviews");

  command.description("Inspect read-only Google Play review signals.");
  command.addCommand(createReviewsRecentCommand());

  return command;
}

export function createReviewsRecentCommand(): Command {
  const command = new Command("recent");

  command
    .description("Summarize recent review complaints and correlate crash/freeze/ANR language with release versions.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option("--track <track>", "Track name used for release metadata.", "production")
    .option(
      "--version-code <versionCode>",
      "Version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option(
      "--rating <rating>",
      "Star rating to include, 1 through 5. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--min-rating <rating>", "Minimum star rating to include.", parseStarRating)
    .option("--max-rating <rating>", "Maximum star rating to include.", parseStarRating)
    .option("--days <days>", "Number of recent UTC days to inspect.", parsePositiveInteger, 7)
    .option("--end-date <date>", "Exclusive UTC end date for the recent window, YYYY-MM-DD. Defaults to tomorrow UTC.")
    .option("--limit <limit>", "Maximum filtered reviews to return.", parsePositiveInteger, 20)
    .option("--fetch-limit <limit>", "Maximum reviews to fetch before local filters are applied.", parsePositiveInteger, 200)
    .option("--translation-language <language>", "Optional Play review translation language code.")
    .option("--review-text <mode>", "Review text output mode: redacted, snippet, or full.", "redacted")
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: ReviewsRecentOptions) => {
      const dateRange = resolveRecentDateRange(options);
      const input = reviewsRecentInputSchema.parse({
        packageName: options.package,
        track: options.track,
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        ratings: normalizeRatings(options.rating ?? []),
        minRating: options.minRating,
        maxRating: options.maxRating,
        startDate: dateRange.startDate,
        endDateExclusive: dateRange.endDateExclusive,
        limit: options.limit,
        fetchLimit: options.fetchLimit,
        translationLanguage: options.translationLanguage,
        reviewText: normalizeReviewTextMode(options.reviewText),
        format: options.format
      });
      const output = await getRecentReviews(input);

      if (input.format === "markdown") {
        printMarkdown(formatReviewsRecentMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function getRecentReviews(
  input: ReviewsRecentInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayPublisherClient;
  } = {}
): Promise<ReviewsRecentOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayPublisherClient(await createAuthenticatedClient(config));
  const [reviewFetch, releaseRows] = await Promise.all([
    fetchRecentReviewPages(client, packageName, input),
    client.listReleases(packageName, input.track)
  ]);
  const releases = releaseRows.map((release) => summarizeRelease(packageName, input.track, release));
  const summarizedReviews = reviewFetch.reviews.flatMap((review) => {
    const summary = summarizeReview(review, { reviewText: input.reviewText });
    return summary ? [summary] : [];
  });
  const matchedReviews = summarizedReviews
    .filter((review) => reviewMatchesRecentFilters(review, input))
    .sort(compareReviewsNewestFirst);
  const returnedReviews = matchedReviews.slice(0, input.limit);
  const summary = createReviewCorrelationSummary({
    packageName,
    track: input.track,
    input,
    matchedReviews,
    returnedReviewCount: returnedReviews.length,
    fetchedReviewCount: reviewFetch.reviews.length,
    releases
  });
  const contextVersionCodes = summary.versionBreakdown
    .map((entry) => entry.versionCode)
    .filter((versionCode) => versionCode !== "unknown");

  return reviewsRecentOutputSchema.parse({
    packageName,
    track: input.track,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive),
      timeZone: REVIEW_TIME_ZONE
    },
    filters: {
      versionCodes: input.versionCodes,
      ratings: input.ratings,
      minRating: input.minRating,
      maxRating: input.maxRating,
      limit: input.limit,
      fetchLimit: input.fetchLimit,
      translationLanguage: input.translationLanguage,
      reviewText: input.reviewText
    },
    releaseContext: {
      latest: selectLatestRelease(releases),
      matchedReleases: releasesMatchingVersionCodes(releases, contextVersionCodes)
    },
    summary,
    reviews: returnedReviews,
    warnings: reviewWarnings({
      input,
      fetchedReviewCount: reviewFetch.reviews.length,
      matchedReviewCount: matchedReviews.length,
      summarizedReviewCount: summarizedReviews.length,
      capped: reviewFetch.capped,
      signalReviewCount: summary.signalReviewCount
    })
  });
}

export function formatReviewsRecentMarkdown(output: ReviewsRecentOutput): string {
  return [
    "# Play Store Recent Review Signals",
    "",
    `Package: ${output.packageName}`,
    `Track: ${output.track}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.timeZone}`,
    `Filters: versions=${output.filters.versionCodes.join(", ") || "all"}, ratings=${formatRatingFilters(output)}`,
    `Review text: ${output.filters.reviewText}`,
    "",
    `**Answer:** ${output.summary.answer}`,
    "",
    "## Next Actions",
    "",
    ...output.summary.nextActions.map((action) => `- ${action}`),
    "",
    "## Version Correlation",
    "",
    "| Version | Release | Status | Rollout | Avg rating | Reviews | Signal reviews | Crash | Freeze | ANR |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    output.summary.versionBreakdown.map(formatVersionRow).join("\n") ||
      "| _none_ | _none_ | _none_ | _none_ | _none_ | 0 | 0 | 0 | 0 | 0 |",
    "",
    "## Reviews",
    "",
    "| Review | Modified | Rating | Version | Signals | Text |",
    "| --- | --- | --- | --- | --- | --- |",
    output.reviews.map(formatReviewRow).join("\n") ||
      "| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |",
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

async function fetchRecentReviewPages(
  client: PlayPublisherClient,
  packageName: string,
  input: ReviewsRecentInput
): Promise<FetchReviewsResult> {
  const reviews: PlayReview[] = [];
  let pageToken: string | undefined;
  let capped = false;

  do {
    const remaining = input.fetchLimit - reviews.length;
    const page = await client.listReviews(packageName, {
      token: pageToken,
      maxResults: Math.min(REVIEW_PAGE_SIZE, remaining),
      translationLanguage: input.translationLanguage
    });

    reviews.push(...page.reviews.slice(0, remaining));

    if (page.nextPageToken && reviews.length >= input.fetchLimit) {
      capped = true;
      pageToken = undefined;
    } else {
      pageToken = page.nextPageToken;
    }
  } while (pageToken && reviews.length < input.fetchLimit);

  return { reviews, capped };
}

function resolvePackageName(packageName: string | undefined, config: PlaystoreConfig): string {
  if (packageName) {
    return packageName;
  }

  if (config.defaultPackage) {
    return config.defaultPackage;
  }

  throw new PlaystoreCliError(
    "INVALID_CONFIG",
    "No package was provided and PLAYSTORE_DEFAULT_PACKAGE is not configured.",
    "Pass --package or set PLAYSTORE_DEFAULT_PACKAGE to an allowed package name."
  );
}

function resolveRecentDateRange(options: Pick<ReviewsRecentOptions, "days" | "endDate">): Pick<ReviewsRecentInput, "startDate" | "endDateExclusive"> {
  const endDateExclusive = options.endDate ?? addDays(todayUtcDate(), 1);

  return {
    startDate: addDays(endDateExclusive, -options.days),
    endDateExclusive
  };
}

function todayUtcDate(now = new Date()): string {
  return [
    String(now.getUTCFullYear()).padStart(4, "0"),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function collectCsvOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitCsv(value)];
}

function normalizeVersionCodes(values: string[]): string[] {
  return dedupe(values.flatMap(splitCsv).map((value) => value.trim()).filter(Boolean));
}

function normalizeRatings(values: string[]): number[] {
  return dedupe(values.flatMap(splitCsv).filter(Boolean).map(parseStarRating));
}

function parseStarRating(value: string): number {
  if (!/^[1-5]$/.test(value)) {
    throw new Error(`Expected a star rating from 1 through 5, received "${value}".`);
  }

  return Number(value);
}

function normalizeReviewTextMode(value: string): ReviewTextMode {
  return reviewTextModeSchema.parse(value.trim().toLowerCase());
}

function compareReviewsNewestFirst(left: ReviewSummary, right: ReviewSummary): number {
  return timestampValue(right.lastModified) - timestampValue(left.lastModified) || left.reviewId.localeCompare(right.reviewId);
}

function timestampValue(value: string | undefined): number {
  return value ? Date.parse(value) : 0;
}

function reviewWarnings(input: {
  input: ReviewsRecentInput;
  fetchedReviewCount: number;
  matchedReviewCount: number;
  summarizedReviewCount: number;
  capped: boolean;
  signalReviewCount: number;
}): string[] {
  const warnings: string[] = [];

  if (input.input.reviewText === "redacted") {
    warnings.push("Review text is redacted by default; keyword classification was computed in memory and raw review bodies are not included.");
  } else {
    warnings.push("Review text output was explicitly enabled; URL, email, phone-like, and long numeric tokens are redacted before output.");
  }

  if (input.capped) {
    warnings.push(
      `Review fetch reached the ${input.input.fetchLimit}-review cap before all pages were read, so local filter counts may be incomplete.`
    );
  }

  if (input.summarizedReviewCount < input.fetchedReviewCount) {
    warnings.push(`${input.fetchedReviewCount - input.summarizedReviewCount} fetched review(s) did not include a user comment and were skipped.`);
  }

  if (input.matchedReviewCount === 0) {
    warnings.push("No reviews matched the requested recent date, version-code, and rating filters.");
  } else if (input.signalReviewCount === 0) {
    warnings.push("No crash, freeze, or ANR keyword complaints were found in the matched reviews.");
  }

  return warnings;
}

function formatRatingFilters(output: ReviewsRecentOutput): string {
  const parts = [
    output.filters.ratings.length > 0 ? output.filters.ratings.join(",") : "",
    output.filters.minRating ? `min=${output.filters.minRating}` : "",
    output.filters.maxRating ? `max=${output.filters.maxRating}` : ""
  ].filter(Boolean);

  return parts.join("; ") || "all";
}

function formatVersionRow(version: ReviewsRecentOutput["summary"]["versionBreakdown"][number]): string {
  return [
    version.versionCode,
    version.releaseName ?? "_unknown_",
    version.status ?? "_unknown_",
    version.rolloutFraction === undefined ? "_n/a_" : String(version.rolloutFraction),
    formatNumber(version.averageRating),
    String(version.reviewCount),
    String(version.signalReviewCount),
    String(version.crashCount),
    String(version.freezeCount),
    String(version.anrCount)
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatReviewRow(review: ReviewSummary): string {
  return [
    review.reviewId,
    review.lastModified ?? "_unknown_",
    review.starRating === undefined ? "_unknown_" : String(review.starRating),
    review.versionCode ?? "_unknown_",
    review.signals.signals.join(", ") || "_none_",
    review.text.included ? review.text.value ?? "" : "_redacted_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatNumber(value: number | null): string {
  return value === null ? "_missing_" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}
