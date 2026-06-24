import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { issueTypeApiValue, rankIssues } from "../domain/issueRanking.js";
import {
  issueStateFilterSchema,
  issuesListInputSchema,
  issueTypeFilterSchema,
  type IssuesListInput,
  type IssueStateFilter,
  type IssueTypeFilter
} from "../schemas/cliInputs.js";
import { issuesListOutputSchema, type IssuesListOutput, type IssueSummary } from "../schemas/cliOutputs.js";
import type { PlayErrorIssue } from "../schemas/playApiTypes.js";
import {
  dateRangeDays,
  parsePositiveInteger,
  PLAY_VITALS_TIME_ZONE,
  previousDateRange,
  type DateRange
} from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { escapeMarkdownTableCell } from "../utils/markdown.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface IssuesListOptions {
  package?: string;
  versionCode?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  type: string;
  state: string;
  limit: number;
  format: string;
}

export function createIssuesCommand(): Command {
  const command = new Command("issues");

  command.description("Browse read-only Google Play crash and ANR issues.");
  command.addCommand(createIssuesListCommand());

  return command;
}

export function createIssuesListCommand(): Command {
  const command = new Command("list");

  command
    .description("List top crash and ANR issues for release version codes over a date range.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option(
      "--version-code <versionCode>",
      "Version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for issue occurrences, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for issue occurrences, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option("--type <type>", "Issue type filter: all, crash, or anr.", "all")
    .option(
      "--state <state>",
      "Issue state filter: all, open, or unknown. open means observed in the requested interval.",
      "all"
    )
    .option("--limit <limit>", "Maximum ranked issues to return.", parsePositiveInteger, 20)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: IssuesListOptions) => {
      const dateRange = resolveRequiredDateRange(options);
      const input = issuesListInputSchema.parse({
        packageName: options.package,
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        startDate: dateRange.startDate,
        endDateExclusive: dateRange.endDateExclusive,
        type: normalizeIssueTypeFilter(options.type),
        state: normalizeIssueStateFilter(options.state),
        limit: options.limit,
        format: options.format
      });
      const output = await listIssues(input);

      if (input.format === "markdown") {
        printMarkdown(formatIssuesMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function listIssues(
  input: IssuesListInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayReportingClient;
  } = {}
): Promise<IssuesListOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayReportingClient(await createAuthenticatedClient(config));
  const dateRange = {
    startDate: input.startDate,
    endDateExclusive: input.endDateExclusive
  };
  const previousRange = previousDateRange(dateRange);
  const filter = buildIssueSearchFilter(input.versionCodes, input.type);
  const candidatePageSize = Math.min(1000, Math.max(input.limit * 5, 50));
  const [currentIssues, previousIssues, userPerceivedIssues] = await Promise.all([
    searchIssueCandidates(client, packageName, dateRange, filter, candidatePageSize, 1),
    searchIssueCandidates(client, packageName, previousRange, filter, 1000, 0),
    searchIssueCandidates(client, packageName, dateRange, addUserPerceivedFilter(filter), 1000, 0)
  ]);
  const issues = rankIssues({
    currentIssues,
    previousIssues,
    userPerceivedIssues,
    dateRange,
    stateFilter: input.state,
    limit: input.limit
  });

  return issuesListOutputSchema.parse({
    packageName,
    versionCodes: input.versionCodes,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive),
      previousStartDate: previousRange.startDate,
      previousEndDateExclusive: previousRange.endDateExclusive,
      timeZone: PLAY_VITALS_TIME_ZONE
    },
    filters: {
      type: input.type,
      state: input.state,
      limit: input.limit
    },
    issues,
    warnings: issueWarnings(issues, input)
  });
}

export function buildIssueSearchFilter(versionCodes: string[], type: IssueTypeFilter): string {
  return [orEquals("versionCode", versionCodes), issueTypeFilter(type)].filter(Boolean).join(" AND ");
}

function issueTypeFilter(type: IssueTypeFilter): string {
  if (type === "all") {
    return orEquals("errorIssueType", [issueTypeApiValue("crash"), issueTypeApiValue("anr")]);
  }

  return orEquals("errorIssueType", [issueTypeApiValue(type)]);
}

function addUserPerceivedFilter(filter: string): string {
  return [filter, "isUserPerceived"].filter(Boolean).join(" AND ");
}

async function searchIssueCandidates(
  client: PlayReportingClient,
  packageName: string,
  dateRange: DateRange,
  filter: string,
  pageSize: number,
  sampleErrorReportLimit: number
): Promise<PlayErrorIssue[]> {
  const pages = await Promise.all(
    ["distinctUsers desc", "errorReportCount desc"].map((orderBy) =>
      client.searchIssues(packageName, {
        interval: dateRange,
        filter,
        orderBy,
        pageSize,
        sampleErrorReportLimit
      })
    )
  );

  return dedupeIssues(pages.flatMap((page) => page.reports));
}

function resolveRequiredDateRange(options: Pick<IssuesListOptions, "startDate" | "endDate" | "days">): DateRange {
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
    "An issue date range is required.",
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

function normalizeIssueTypeFilter(value: string): IssueTypeFilter {
  return issueTypeFilterSchema.parse(value.trim().toLowerCase());
}

function normalizeIssueStateFilter(value: string): IssueStateFilter {
  return issueStateFilterSchema.parse(value.trim().toLowerCase());
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

function dedupeIssues(issues: PlayErrorIssue[]): PlayErrorIssue[] {
  return [...new Map(issues.map((issue) => [issue.name, issue])).values()];
}

function issueWarnings(issues: IssueSummary[], input: IssuesListInput): string[] {
  const warnings = issues.length === 0 ? ["No crash or ANR issues were returned for the requested filters."] : [];

  if (input.state !== "all") {
    warnings.push(
      "Google Play Developer Reporting does not expose issue lifecycle state; this state filter is derived from lastErrorReportTime within the requested America/Los_Angeles interval."
    );
  }

  return warnings;
}

function formatIssuesMarkdown(output: IssuesListOutput): string {
  const rows = output.issues.map(formatIssueRow).join("\n");

  return [
    "# Play Store Crash and ANR Issues",
    "",
    `Package: ${output.packageName}`,
    `Version codes: ${output.versionCodes.join(", ")}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.timeZone}`,
    `Previous window: ${output.dateRange.previousStartDate} to ${output.dateRange.previousEndDateExclusive} (exclusive)`,
    `Filters: type=${output.filters.type}, state=${output.filters.state}, limit=${output.filters.limit}`,
    "",
    "| Rank | Type | Issue | State | Affected users | Events | User growth | Event growth | User-perceived | Last report | Cause / location |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |",
    "",
    output.warnings.length > 0 ? ["## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function formatIssueRow(issue: IssueSummary): string {
  return [
    String(issue.rank.position),
    issue.type,
    issue.issueId,
    issue.state,
    formatNumber(issue.current.affectedUsers),
    formatNumber(issue.current.eventCount),
    formatSignedNumber(issue.growth.affectedUsersDelta),
    formatSignedNumber(issue.growth.eventCountDelta),
    issue.impact.userPerceived
      ? `${formatNumber(issue.impact.userPerceivedAffectedUsers)} users / ${formatNumber(issue.impact.userPerceivedEventCount)} events`
      : "no",
    issue.lastErrorReportTime ?? "_unknown_",
    [issue.cause, issue.location].filter(Boolean).join(" @ ") || "_unknown_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
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
