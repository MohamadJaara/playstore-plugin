import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { issueIdFromName, issueTypeApiValue } from "../domain/issueRanking.js";
import { extractStackTrace } from "../domain/stackTraceParser.js";
import {
  issueTypeFilterSchema,
  reportsListInputSchema,
  type IssueTypeFilter,
  type ReportsListInput
} from "../schemas/cliInputs.js";
import { reportsListOutputSchema, type ErrorReportSummary, type ReportsListOutput } from "../schemas/cliOutputs.js";
import type { PlayErrorReport } from "../schemas/playApiTypes.js";
import { dateRangeDays, parsePositiveInteger, PLAY_VITALS_TIME_ZONE, type DateRange } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface ReportsListOptions {
  package?: string;
  issueId: string;
  versionCode?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  type: string;
  limit: number;
  format: string;
}

export function createReportsCommand(): Command {
  const command = new Command("reports");

  command.description("Browse read-only Google Play crash and ANR sample reports.");
  command.addCommand(createReportsListCommand());

  return command;
}

export function createReportsListCommand(): Command {
  const command = new Command("list");

  command
    .description("List representative reports for a selected crash or ANR issue.")
    .requiredOption("--issue-id <issueId>", "Error issue id or full error issue resource name.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option(
      "--version-code <versionCode>",
      "Version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for report occurrences, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for report occurrences, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option("--type <type>", "Issue type filter: all, crash, or anr.", "all")
    .option("--limit <limit>", "Maximum reports to return.", parsePositiveInteger, 10)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: ReportsListOptions) => {
      const dateRange = resolveOptionalDateRange(options);
      const input = reportsListInputSchema.parse({
        packageName: options.package,
        issueId: issueIdFromName(options.issueId),
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        startDate: dateRange?.startDate,
        endDateExclusive: dateRange?.endDateExclusive,
        type: normalizeIssueTypeFilter(options.type),
        limit: options.limit,
        format: options.format
      });
      const output = await listReports(input);

      if (input.format === "markdown") {
        printMarkdown(formatReportsMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function listReports(
  input: ReportsListInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayReportingClient;
  } = {}
): Promise<ReportsListOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayReportingClient(await createAuthenticatedClient(config));
  const dateRange = input.startDate && input.endDateExclusive ? { startDate: input.startDate, endDateExclusive: input.endDateExclusive } : undefined;
  const page = await client.searchReports(packageName, {
    interval: dateRange,
    filter: buildReportsSearchFilter(input.issueId, input.versionCodes, input.type),
    pageSize: input.limit
  });
  const reports = page.reports.map(summarizeReport);

  return reportsListOutputSchema.parse({
    packageName,
    issueId: input.issueId,
    dateRange: dateRange
      ? {
          startDate: dateRange.startDate,
          endDateExclusive: dateRange.endDateExclusive,
          days: dateRangeDays(dateRange.startDate, dateRange.endDateExclusive),
          timeZone: PLAY_VITALS_TIME_ZONE
        }
      : undefined,
    filters: {
      type: input.type,
      versionCodes: input.versionCodes,
      limit: input.limit
    },
    reports,
    warnings: reportWarnings(reports)
  });
}

export function buildReportsSearchFilter(issueId: string, versionCodes: string[], type: IssueTypeFilter): string {
  return [orEquals("errorIssueId", [issueId]), versionCodes.length > 0 ? orEquals("versionCode", versionCodes) : "", issueTypeFilter(type)]
    .filter(Boolean)
    .join(" AND ");
}

function issueTypeFilter(type: IssueTypeFilter): string {
  if (type === "all") {
    return orEquals("errorIssueType", [issueTypeApiValue("crash"), issueTypeApiValue("anr")]);
  }

  return orEquals("errorIssueType", [issueTypeApiValue(type)]);
}

function summarizeReport(report: PlayErrorReport): ErrorReportSummary {
  return {
    reportId: issueIdFromName(report.name),
    name: report.name,
    issueId: report.issue ? issueIdFromName(report.issue) : undefined,
    issue: report.issue,
    type: report.type ?? "unknown",
    versionCode: report.appVersion?.versionCode,
    apiLevel: report.osVersion?.apiLevel,
    device: {
      marketingName: report.deviceModel?.marketingName,
      brand: report.deviceModel?.deviceId?.buildBrand,
      device: report.deviceModel?.deviceId?.buildDevice,
      uri: report.deviceModel?.deviceUri
    },
    eventTime: report.eventTime,
    vcsInformation: report.vcsInformation,
    stackTrace: extractStackTrace(report.reportText)
  };
}

function resolveOptionalDateRange(options: Pick<ReportsListOptions, "startDate" | "endDate" | "days">): DateRange | undefined {
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

  if (options.startDate || options.endDate || options.days) {
    throw new PlaystoreCliError(
      "INVALID_CONFIG",
      "The report date range is incomplete.",
      "Pass --start-date and --end-date, or pass --days with --end-date. Omit all date options to search without a date range."
    );
  }

  return undefined;
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

function normalizeIssueTypeFilter(value: string): IssueTypeFilter {
  return issueTypeFilterSchema.parse(value.trim().toLowerCase());
}

function orEquals(field: string, values: string[]): string {
  const expression = values.map((value) => `${field} = ${filterValue(value)}`).join(" OR ");

  return values.length > 1 ? `(${expression})` : expression;
}

function filterValue(value: string): string {
  return /^\d+$/.test(value) || /^[A-Z_]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}

function reportWarnings(reports: ErrorReportSummary[]): string[] {
  const warnings = reports.length === 0 ? ["No reports were returned for the requested issue and filters."] : [];
  const malformedCount = reports.filter((report) => report.stackTrace.malformedLines.length > 0).length;
  const missingStackCount = reports.filter((report) => report.stackTrace.frames.length === 0).length;

  if (malformedCount > 0) {
    warnings.push(`${malformedCount} report(s) contained malformed stack trace lines that could not be parsed.`);
  }

  if (missingStackCount > 0) {
    warnings.push(`${missingStackCount} report(s) did not include parseable stack frames.`);
  }

  return warnings;
}

function formatReportsMarkdown(output: ReportsListOutput): string {
  const summaryRows = output.reports.map(formatReportRow).join("\n");
  const reportSections = output.reports.map(formatReportSection).join("\n\n");

  return [
    "# Play Store Error Reports",
    "",
    `Package: ${output.packageName}`,
    `Issue: ${output.issueId}`,
    output.dateRange
      ? `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.timeZone}`
      : "Date range: _not specified_",
    `Filters: type=${output.filters.type}, versionCodes=${output.filters.versionCodes.join(", ") || "all"}, limit=${output.filters.limit}`,
    "",
    "| Report | Type | Version | API | Device | Event time | Top frame |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    summaryRows || "| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |",
    reportSections ? ["", "## Stack Traces", "", reportSections].join("\n") : "",
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function formatReportRow(report: ErrorReportSummary): string {
  return [
    report.reportId,
    report.type,
    report.versionCode ?? "_unknown_",
    report.apiLevel ?? "_unknown_",
    formatDevice(report),
    report.eventTime ?? "_unknown_",
    report.stackTrace.rawTopFrame ?? "_none_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatReportSection(report: ErrorReportSummary): string {
  const header = `### ${report.reportId}`;
  const metadata = [
    `Event time: ${report.eventTime ?? "_unknown_"}`,
    `Version: ${report.versionCode ?? "_unknown_"}`,
    `API level: ${report.apiLevel ?? "_unknown_"}`,
    `Device: ${formatDevice(report)}`
  ].join("\n");
  const exception = report.stackTrace.exceptionType
    ? `Exception: ${report.stackTrace.exceptionType}${report.stackTrace.exceptionMessage ? `: ${report.stackTrace.exceptionMessage}` : ""}`
    : report.stackTrace.signal
      ? `Signal: ${report.stackTrace.signal}`
      : "Exception: _unknown_";
  const frames = report.stackTrace.frames.map((frame) => frame.raw).join("\n") || "_No parseable stack frames._";

  return [header, "", metadata, exception, "", "```", frames, "```"].join("\n");
}

function formatDevice(report: ErrorReportSummary): string {
  if (report.device.marketingName) {
    return report.device.marketingName;
  }

  const deviceId = [report.device.brand, report.device.device].filter(Boolean).join("/");

  return deviceId || "_unknown_";
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0")
  ].join("-");
}
