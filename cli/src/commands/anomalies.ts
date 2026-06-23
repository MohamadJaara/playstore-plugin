import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { issueIdFromName } from "../domain/issueRanking.js";
import {
  anomaliesListInputSchema,
  anomalySignalFilterSchema,
  type AnomaliesListInput,
  type AnomalySignalFilter
} from "../schemas/cliInputs.js";
import { anomaliesListOutputSchema, type AnomaliesListOutput, type AnomalySignal, type AnomalySummary } from "../schemas/cliOutputs.js";
import type { PlayAnomaly, PlayDimensionValue, PlayMetricDateTime, PlayMetricValue } from "../schemas/playApiTypes.js";
import { addDays, dateRangeDays, parsePositiveInteger, PLAY_VITALS_TIME_ZONE, type DateRange } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface AnomaliesListOptions {
  package?: string;
  versionCode?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  signal: string;
  limit: number;
  format: string;
}

const ANOMALY_PAGE_SIZE = 100;
const ANOMALY_FILTER_TIME_ZONE = PLAY_VITALS_TIME_ZONE;

export function createAnomaliesCommand(): Command {
  const command = new Command("anomalies");

  command.description("List read-only Google Play Developer Reporting anomalies.");
  command.addCommand(createAnomaliesListCommand());

  return command;
}

export function createAnomaliesListCommand(): Command {
  const command = new Command("list");

  command
    .description("List Play Developer Reporting anomalies active in a date range.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option(
      "--version-code <versionCode>",
      "Version code to include when an anomaly has a versionCode dimension. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for active anomalies, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for active anomalies, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option("--signal <signal>", "Signal filter: all, crash, or anr.", "all")
    .option("--limit <limit>", "Maximum anomalies to return after local filters.", parsePositiveInteger, 20)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: AnomaliesListOptions) => {
      const dateRange = resolveRequiredDateRange(options);
      const input = anomaliesListInputSchema.parse({
        packageName: options.package,
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        startDate: dateRange.startDate,
        endDateExclusive: dateRange.endDateExclusive,
        signal: normalizeAnomalySignalFilter(options.signal),
        limit: options.limit,
        format: options.format
      });
      const output = await listAnomalies(input);

      if (input.format === "markdown") {
        printMarkdown(formatAnomaliesMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function listAnomalies(
  input: AnomaliesListInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayReportingClient;
  } = {}
): Promise<AnomaliesListOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayReportingClient(await createAuthenticatedClient(config));
  const filter = buildAnomalyActiveBetweenFilter(input.startDate, input.endDateExclusive);
  const anomalies: AnomalySummary[] = [];
  let fetchedCount = 0;
  let pageToken: string | undefined;
  let capped = false;

  do {
    const page = await client.listAnomalies(packageName, {
      filter,
      pageSize: ANOMALY_PAGE_SIZE,
      pageToken
    });
    fetchedCount += page.reports.length;

    for (const [index, anomaly] of page.reports.entries()) {
      const summary = summarizeAnomaly(anomaly);

      if (!matchesAnomalyFilters(summary, input)) {
        continue;
      }

      anomalies.push(summary);

      if (anomalies.length >= input.limit) {
        capped = Boolean(page.nextPageToken) || index < page.reports.length - 1;
        break;
      }
    }

    pageToken = anomalies.length >= input.limit ? undefined : page.nextPageToken;
  } while (pageToken);

  return anomaliesListOutputSchema.parse({
    packageName,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive),
      filterTimeZone: ANOMALY_FILTER_TIME_ZONE
    },
    filters: {
      versionCodes: input.versionCodes,
      signal: input.signal,
      limit: input.limit
    },
    anomalies,
    warnings: anomalyWarnings({ anomalies, fetchedCount, capped, input })
  });
}

export function buildAnomalyActiveBetweenFilter(startDate: string, endDateExclusive: string): string {
  return `activeBetween("${dateOnlyToZonedStartRfc3339(startDate)}", "${dateOnlyToZonedStartRfc3339(endDateExclusive)}")`;
}

export function summarizeAnomaly(anomaly: PlayAnomaly): AnomalySummary {
  const dimensions = summarizeDimensions(anomaly.dimensions ?? []);
  const metric = summarizeMetric(anomaly.metric);

  return {
    anomalyId: issueIdFromName(anomaly.name),
    name: anomaly.name,
    signal: signalForAnomaly(anomaly.metricSet, metric?.name),
    metricSet: anomaly.metricSet,
    timeline: {
      aggregationPeriod: anomaly.timelineSpec?.aggregationPeriod,
      startTime: formatMetricDateTime(anomaly.timelineSpec?.startTime),
      endTimeExclusive: formatMetricDateTime(anomaly.timelineSpec?.endTime),
      timeZone: anomaly.timelineSpec?.startTime?.timeZone?.id ?? anomaly.timelineSpec?.endTime?.timeZone?.id
    },
    metric,
    dimensions: dimensions.values,
    dimensionLabels: dimensions.labels,
    versionCodes: dimensions.values.versionCode ? [dimensions.values.versionCode] : []
  };
}

function resolveRequiredDateRange(options: Pick<AnomaliesListOptions, "startDate" | "endDate" | "days">): DateRange {
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
    "An anomaly date range is required.",
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

function normalizeAnomalySignalFilter(value: string): AnomalySignalFilter {
  return anomalySignalFilterSchema.parse(value.trim().toLowerCase());
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}

function summarizeDimensions(dimensions: PlayDimensionValue[]): {
  values: Record<string, string>;
  labels: Record<string, string>;
} {
  const entries = dimensions.flatMap((dimension): Array<[string, string]> => {
    if (!dimension.dimension) {
      return [];
    }

    return [[dimension.dimension, dimension.stringValue ?? dimension.int64Value ?? ""]];
  });
  const labelEntries = dimensions.flatMap((dimension): Array<[string, string]> => {
    if (!dimension.dimension || !dimension.valueLabel) {
      return [];
    }

    return [[dimension.dimension, dimension.valueLabel]];
  });

  return {
    values: Object.fromEntries(entries),
    labels: Object.fromEntries(labelEntries)
  };
}

function summarizeMetric(metric: PlayMetricValue | undefined): AnomalySummary["metric"] | undefined {
  if (!metric?.metric) {
    return undefined;
  }

  return {
    name: metric.metric,
    value: decimalValue(metric.decimalValue?.value),
    confidenceInterval: metric.decimalValueConfidenceInterval
      ? {
          lowerBound: decimalValue(metric.decimalValueConfidenceInterval.lowerBound?.value),
          upperBound: decimalValue(metric.decimalValueConfidenceInterval.upperBound?.value)
        }
      : undefined
  };
}

function decimalValue(value: string | undefined): number | null {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function signalForAnomaly(metricSet: string | undefined, metricName: string | undefined): AnomalySignal {
  const value = `${metricSet ?? ""} ${metricName ?? ""}`.toLowerCase();

  if (value.includes("crash")) {
    return "crash";
  }

  if (value.includes("anr")) {
    return "anr";
  }

  return "unknown";
}

function formatMetricDateTime(value: PlayMetricDateTime | undefined): string | undefined {
  if (!value?.year || !value.month || !value.day) {
    return undefined;
  }

  const date = [
    String(value.year).padStart(4, "0"),
    String(value.month).padStart(2, "0"),
    String(value.day).padStart(2, "0")
  ].join("-");

  if (value.hours === undefined && value.minutes === undefined && value.seconds === undefined) {
    return date;
  }

  return [
    date,
    [
      String(value.hours ?? 0).padStart(2, "0"),
      String(value.minutes ?? 0).padStart(2, "0"),
      String(value.seconds ?? 0).padStart(2, "0")
    ].join(":")
  ].join("T");
}

function matchesAnomalyFilters(summary: AnomalySummary, input: AnomaliesListInput): boolean {
  const signalMatches = input.signal === "all" || summary.signal === input.signal;
  const versionMatches =
    input.versionCodes.length === 0 ||
    summary.versionCodes.length === 0 ||
    summary.versionCodes.some((versionCode) => input.versionCodes.includes(versionCode));

  return signalMatches && versionMatches;
}

function anomalyWarnings(input: {
  anomalies: AnomalySummary[];
  fetchedCount: number;
  capped: boolean;
  input: AnomaliesListInput;
}): string[] {
  const warnings: string[] = [];

  if (input.anomalies.length === 0 && input.fetchedCount === 0) {
    warnings.push("No anomalies were returned for the requested active date range.");
  } else if (input.anomalies.length === 0) {
    warnings.push("Anomalies were returned for the active date range, but none matched the local signal/version filters.");
  }

  if (input.capped) {
    warnings.push(`Anomaly output reached the ${input.input.limit}-item limit before all matching anomalies were returned.`);
  }

  if (input.input.versionCodes.length > 0) {
    warnings.push("Version-code filtering is applied locally when an anomaly includes a versionCode dimension; app-wide anomalies are retained.");
  }

  return warnings;
}

export function formatAnomaliesMarkdown(output: AnomaliesListOutput): string {
  return [
    "# Play Store Anomalies",
    "",
    `Package: ${output.packageName}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.filterTimeZone}`,
    `Filters: versions=${output.filters.versionCodes.join(", ") || "all"}, signal=${output.filters.signal}, limit=${output.filters.limit}`,
    "",
    "| Signal | Anomaly | Metric | Value | Window | Dimensions |",
    "| --- | --- | --- | --- | --- | --- |",
    output.anomalies.map(formatAnomalyRow).join("\n") ||
      "| _none_ | _none_ | _none_ | _missing_ | _unknown_ | _none_ |",
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function formatAnomalyRow(anomaly: AnomalySummary): string {
  return [
    anomaly.signal,
    anomaly.anomalyId,
    anomaly.metric?.name ?? "_unknown_",
    formatNumber(anomaly.metric?.value ?? null),
    formatTimeline(anomaly),
    formatDimensions(anomaly.dimensions, anomaly.dimensionLabels)
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatTimeline(anomaly: AnomalySummary): string {
  const start = anomaly.timeline.startTime ?? "_unknown_";
  const end = anomaly.timeline.endTimeExclusive ?? "_unknown_";

  return `${start} to ${end}`;
}

function formatDimensions(dimensions: Record<string, string>, labels: Record<string, string>): string {
  const entries = Object.entries(dimensions);

  if (entries.length === 0) {
    return "_none_";
  }

  return entries
    .map(([key, value]) => {
      const label = labels[key];
      return label ? `${key}=${value || "_unknown_"} (${label})` : `${key}=${value || "_unknown_"}`;
    })
    .join(", ");
}

function formatNumber(value: number | null): string {
  return value === null ? "_missing_" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function dateOnlyToZonedStartRfc3339(date: string, timeZone = ANOMALY_FILTER_TIME_ZONE): string {
  return `${date}T00:00:00${timeZoneOffsetForDateOnly(date, timeZone)}`;
}

function timeZoneOffsetForDateOnly(date: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const noonOffset = offsetMinutesForInstant(noonUtc, timeZone);
  const localMidnightUtc = new Date(Date.UTC(year, month - 1, day) - noonOffset * 60_000);
  const midnightOffset = offsetMinutesForInstant(localMidnightUtc, timeZone);

  return formatOffset(midnightOffset);
}

function offsetMinutesForInstant(date: Date, timeZone: string): number {
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit"
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = timeZoneName?.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/);

  if (!match?.groups?.sign) {
    return 0;
  }

  const sign = match.groups.sign === "-" ? -1 : 1;
  return sign * (Number(match.groups.hours) * 60 + Number(match.groups.minutes));
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;

  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
