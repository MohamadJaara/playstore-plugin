import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayPublisherClient, type PlayPublisherClient } from "../clients/playPublisherClient.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { assessRolloutRisk } from "../domain/rolloutRisk.js";
import {
  reportRolloutRiskInputSchema,
  type ReportRolloutRiskInput
} from "../schemas/cliInputs.js";
import { rolloutRiskReportOutputSchema, type RolloutRiskReportOutput } from "../schemas/cliOutputs.js";
import { addDays, dateRangeDays, parsePositiveInteger, type DateRange } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";
import { listAnomalies } from "./anomalies.js";
import { getReleaseHealth } from "./health.js";
import { listIssues } from "./issues.js";
import { getRecentReviews } from "./reviews.js";

interface ReportRolloutRiskOptions {
  package?: string;
  track: string;
  versionCode?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  issueLimit: number;
  anomalyLimit: number;
  reviewLimit: number;
  reviewFetchLimit: number;
  maxRating: number;
  format: string;
}

export function createReportCommand(): Command {
  const command = new Command("report");

  command.description("Generate read-only Play Store decision-aid reports.");
  command.addCommand(createReportRolloutRiskCommand());

  return command;
}

export function createReportRolloutRiskCommand(): Command {
  const command = new Command("rollout-risk");

  command
    .description("Generate a combined release rollout risk report from measured health, issues, anomalies, and reviews.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option("--track <track>", "Track name used for release context.", "production")
    .option(
      "--version-code <versionCode>",
      "Release version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for measured facts, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for measured facts, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option("--issue-limit <limit>", "Maximum top issues to include.", parsePositiveInteger, 10)
    .option("--anomaly-limit <limit>", "Maximum anomalies to include.", parsePositiveInteger, 20)
    .option("--review-limit <limit>", "Maximum recent reviews to include. Review text remains redacted.", parsePositiveInteger, 20)
    .option("--review-fetch-limit <limit>", "Maximum reviews to fetch before local filters are applied.", parsePositiveInteger, 200)
    .option("--max-rating <rating>", "Maximum star rating for review-signal facts.", parseStarRating, 2)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: ReportRolloutRiskOptions) => {
      const dateRange = resolveRequiredDateRange(options);
      const input = reportRolloutRiskInputSchema.parse({
        packageName: options.package,
        track: options.track,
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        startDate: dateRange.startDate,
        endDateExclusive: dateRange.endDateExclusive,
        issueLimit: options.issueLimit,
        anomalyLimit: options.anomalyLimit,
        reviewLimit: options.reviewLimit,
        reviewFetchLimit: options.reviewFetchLimit,
        maxRating: options.maxRating,
        format: options.format
      });
      const output = await getRolloutRiskReport(input);

      if (input.format === "markdown") {
        printMarkdown(formatRolloutRiskMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function getRolloutRiskReport(
  input: ReportRolloutRiskInput,
  dependencies: {
    config?: PlaystoreConfig;
    reportingClient?: PlayReportingClient;
    publisherClient?: PlayPublisherClient;
  } = {}
): Promise<RolloutRiskReportOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const authenticatedClient =
    dependencies.reportingClient && dependencies.publisherClient ? undefined : await createAuthenticatedClient(config);
  const reportingClient = dependencies.reportingClient ?? createPlayReportingClient(authenticatedClient!);
  const publisherClient = dependencies.publisherClient ?? createPlayPublisherClient(authenticatedClient!);

  const [health, topIssues, anomalies, reviews] = await Promise.all([
    getReleaseHealth(
      {
        packageName,
        track: input.track,
        versionCodes: input.versionCodes,
        startDate: input.startDate,
        endDateExclusive: input.endDateExclusive,
        dimensions: [],
        format: "json"
      },
      { config, client: reportingClient }
    ),
    listIssues(
      {
        packageName,
        versionCodes: input.versionCodes,
        startDate: input.startDate,
        endDateExclusive: input.endDateExclusive,
        type: "all",
        state: "all",
        limit: input.issueLimit,
        format: "json"
      },
      { config, client: reportingClient }
    ),
    listAnomalies(
      {
        packageName,
        versionCodes: input.versionCodes,
        startDate: input.startDate,
        endDateExclusive: input.endDateExclusive,
        signal: "all",
        limit: input.anomalyLimit,
        format: "json"
      },
      { config, client: reportingClient }
    ),
    getRecentReviews(
      {
        packageName,
        track: input.track,
        versionCodes: input.versionCodes,
        ratings: [],
        minRating: undefined,
        maxRating: input.maxRating,
        startDate: input.startDate,
        endDateExclusive: input.endDateExclusive,
        limit: input.reviewLimit,
        fetchLimit: input.reviewFetchLimit,
        translationLanguage: undefined,
        reviewText: "redacted",
        format: "json"
      },
      { config, client: publisherClient }
    )
  ]);
  const facts = {
    health,
    topIssues,
    anomalies,
    reviews
  };
  const recommendation = assessRolloutRisk({ facts });

  return rolloutRiskReportOutputSchema.parse({
    packageName,
    track: input.track,
    versionCodes: input.versionCodes,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive)
    },
    facts,
    recommendation,
    warnings: reportWarnings(facts)
  });
}

function resolveRequiredDateRange(options: Pick<ReportRolloutRiskOptions, "startDate" | "endDate" | "days">): DateRange {
  if (options.startDate && options.endDate) {
    return {
      startDate: options.startDate,
      endDateExclusive: options.endDate
    };
  }

  if (options.days && options.endDate) {
    return {
      startDate: addDays(options.endDate, -options.days),
      endDateExclusive: options.endDate
    };
  }

  throw new PlaystoreCliError(
    "INVALID_CONFIG",
    "A rollout-risk report date range is required.",
    "Pass --start-date and --end-date, or pass --days with --end-date. --end-date is exclusive."
  );
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

function collectCsvOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitCsv(value)];
}

function normalizeVersionCodes(values: string[]): string[] {
  return dedupe(values.flatMap(splitCsv).map((value) => value.trim()).filter(Boolean));
}

function parseStarRating(value: string): number {
  if (!/^[1-5]$/.test(value)) {
    throw new Error(`Expected a star rating from 1 through 5, received "${value}".`);
  }

  return Number(value);
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function reportWarnings(facts: RolloutRiskReportOutput["facts"]): string[] {
  return dedupe([
    ...facts.health.warnings.map((warning) => `health: ${warning}`),
    ...facts.topIssues.warnings.map((warning) => `issues: ${warning}`),
    ...facts.anomalies.warnings.map((warning) => `anomalies: ${warning}`),
    ...facts.reviews.warnings.map((warning) => `reviews: ${warning}`)
  ]);
}

export function formatRolloutRiskMarkdown(output: RolloutRiskReportOutput): string {
  return [
    "# Play Store Rollout Risk Report",
    "",
    `Package: ${output.packageName}`,
    `Track: ${output.track}`,
    `Version codes: ${output.versionCodes.join(", ")}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive)`,
    "",
    "## Inferred Recommendation",
    "",
    `Category: **${output.recommendation.category}**`,
    `Score: ${output.recommendation.score}/${output.recommendation.maxScore}`,
    `Basis: ${output.recommendation.basis}`,
    "",
    ...output.recommendation.reasons.map((reason) => `- ${reason}`),
    "",
    "### Next Actions",
    "",
    ...output.recommendation.nextActions.map((action) => `- ${action}`),
    "",
    `Read-only notice: ${output.recommendation.readOnlyNotice}`,
    "",
    "## Measured Facts",
    "",
    "### Health Metrics",
    "",
    "| Signal | Rate | User-perceived rate | Distinct user-days | Data points |",
    "| --- | --- | --- | --- | --- |",
    output.facts.health.metricGroups.map(formatHealthRow).join("\n") ||
      "| _none_ | _missing_ | _missing_ | _missing_ | 0 |",
    "",
    "### Top Issues",
    "",
    "| Rank | Issue | Type | Affected users | Events | User-perceived users | Growth | Last report |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    output.facts.topIssues.issues.map(formatIssueRow).join("\n") ||
      "| _none_ | _none_ | _none_ | 0 | 0 | 0 | 0 | _unknown_ |",
    "",
    "### Active Anomalies",
    "",
    "| Signal | Anomaly | Metric | Value | Version dimensions | Window |",
    "| --- | --- | --- | --- | --- | --- |",
    output.facts.anomalies.anomalies.map(formatAnomalyRow).join("\n") ||
      "| _none_ | _none_ | _none_ | _missing_ | _none_ | _unknown_ |",
    "",
    "### Review Signals",
    "",
    `Matched reviews: ${formatNumber(output.facts.reviews.summary.matchedReviewCount)}`,
    `Low-rating crash/freeze/ANR signal reviews: ${formatNumber(output.facts.reviews.summary.lowRatingSignalReviewCount)}`,
    `Signal breakdown: crash=${formatNumber(output.facts.reviews.summary.crashCount)}, freeze=${formatNumber(output.facts.reviews.summary.freezeCount)}, anr=${formatNumber(output.facts.reviews.summary.anrCount)}`,
    `Average rating: ${formatNullableNumber(output.facts.reviews.summary.averageRating)}`,
    "Review text: redacted",
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function formatHealthRow(group: RolloutRiskReportOutput["facts"]["health"]["metricGroups"][number]): string {
  return [
    titleCase(group.signal),
    formatRatio(group.summary.rate.value),
    formatRatio(group.summary.userPerceivedRate.value),
    formatNullableNumber(group.summary.distinctUsers.userDays),
    String(Math.max(group.summary.rate.dataPoints, group.summary.userPerceivedRate.dataPoints))
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatIssueRow(issue: RolloutRiskReportOutput["facts"]["topIssues"]["issues"][number]): string {
  return [
    String(issue.rank.position),
    issue.issueId,
    issue.type,
    formatNumber(issue.current.affectedUsers),
    formatNumber(issue.current.eventCount),
    formatNumber(issue.impact.userPerceivedAffectedUsers),
    formatSignedNumber(issue.growth.affectedUsersDelta),
    issue.lastErrorReportTime ?? "_unknown_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatAnomalyRow(anomaly: RolloutRiskReportOutput["facts"]["anomalies"]["anomalies"][number]): string {
  return [
    anomaly.signal,
    anomaly.anomalyId,
    anomaly.metric?.name ?? "_unknown_",
    formatNullableNumber(anomaly.metric?.value ?? null),
    anomaly.versionCodes.join(", ") || "app-wide",
    `${anomaly.timeline.startTime ?? "_unknown_"} to ${anomaly.timeline.endTimeExclusive ?? "_unknown_"}`
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatRatio(value: number | null): string {
  return value === null ? "_missing_" : `${(value * 100).toFixed(3)}%`;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "_missing_" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
