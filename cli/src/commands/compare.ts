import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { buildIssueSearchFilter } from "./issues.js";
import {
  aggregateReleaseHealthMetricGroup,
  buildReleaseHealthTimelineSpec,
  buildVersionCodeFilter,
  RELEASE_HEALTH_AGGREGATION_PERIOD,
  RELEASE_HEALTH_METRICS,
  type ReleaseHealthMetricConfig,
  type ReleaseHealthMetricInputRow
} from "../domain/releaseHealth.js";
import { detectReleaseRegressions } from "../domain/regressionDetection.js";
import {
  compareReleasesInputSchema,
  issueTypeFilterSchema,
  type CompareReleasesInput,
  type IssueTypeFilter
} from "../schemas/cliInputs.js";
import {
  compareReleasesOutputSchema,
  type CompareReleasesOutput,
  type RegressionIssueChange,
  type RegressionSeverity,
  type ReleaseHealthMetricGroup,
  type ReleaseMetricRegression
} from "../schemas/cliOutputs.js";
import type { PlayErrorIssue } from "../schemas/playApiTypes.js";
import { addDays, dateRangeDays, parsePositiveInteger, PLAY_VITALS_TIME_ZONE, previousDateRange, type DateRange } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface CompareReleasesOptions {
  package?: string;
  track: string;
  current?: string[];
  previous?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  type: string;
  limit: number;
  format: string;
}

interface IssueSearchResult {
  issues: PlayErrorIssue[];
  capped: boolean;
  fetchedResults: number;
}

interface IssueSearchWarning {
  label: string;
  result: IssueSearchResult;
  suppressesAbsenceLabels: boolean;
}

const ISSUE_SEARCH_PAGE_SIZE = 1000;
const ISSUE_SEARCH_MAX_RESULTS_PER_ORDER = 5000;

export function createCompareCommand(): Command {
  const command = new Command("compare");

  command.description("Compare Google Play release health and issue signals.");
  command.addCommand(createCompareReleasesCommand());

  return command;
}

export function createCompareReleasesCommand(): Command {
  const command = new Command("releases");

  command
    .description("Compare a current release to a previous release and report what got worse.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option("--track <track>", "Track name used for release context.", "production")
    .option(
      "--current <versionCode>",
      "Current release version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option(
      "--previous <versionCode>",
      "Previous release version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for comparison metrics and issue occurrences, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for comparison metrics and issue occurrences, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option("--type <type>", "Issue type filter: all, crash, or anr.", "all")
    .option("--limit <limit>", "Maximum issue changes to return in each section.", parsePositiveInteger, 20)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: CompareReleasesOptions) => {
      const dateRange = resolveRequiredDateRange(options);
      const input = compareReleasesInputSchema.parse({
        packageName: options.package,
        track: options.track,
        currentVersionCodes: normalizeVersionCodes(options.current ?? []),
        previousVersionCodes: normalizeVersionCodes(options.previous ?? []),
        startDate: dateRange.startDate,
        endDateExclusive: dateRange.endDateExclusive,
        type: normalizeIssueTypeFilter(options.type),
        limit: options.limit,
        format: options.format
      });
      const output = await compareReleases(input);

      if (input.format === "markdown") {
        printMarkdown(formatCompareReleasesMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function compareReleases(
  input: CompareReleasesInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayReportingClient;
    issueSearchMaxResultsPerOrder?: number;
  } = {}
): Promise<CompareReleasesOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayReportingClient(await createAuthenticatedClient(config));
  const dateRange = {
    startDate: input.startDate,
    endDateExclusive: input.endDateExclusive
  };
  const historicalRange = previousDateRange(dateRange);
  const issueSearchMaxResultsPerOrder = dependencies.issueSearchMaxResultsPerOrder ?? ISSUE_SEARCH_MAX_RESULTS_PER_ORDER;
  const currentIssueFilter = buildIssueSearchFilter(input.currentVersionCodes, input.type);
  const previousIssueFilter = buildIssueSearchFilter(input.previousVersionCodes, input.type);
  const historicalIssueFilter = buildIssueSearchFilter(
    dedupe([...input.currentVersionCodes, ...input.previousVersionCodes]),
    input.type
  );

  const [
    currentMetricGroups,
    previousMetricGroups,
    currentIssueSearch,
    previousIssueSearch,
    historicalIssueSearch,
    currentUserPerceivedIssueSearch,
    previousUserPerceivedIssueSearch,
    historicalUserPerceivedIssueSearch
  ] = await Promise.all([
    queryReleaseMetricGroups(client, packageName, input.currentVersionCodes, dateRange),
    queryReleaseMetricGroups(client, packageName, input.previousVersionCodes, dateRange),
    searchIssueCandidates(client, packageName, dateRange, currentIssueFilter, ISSUE_SEARCH_PAGE_SIZE, 1, issueSearchMaxResultsPerOrder),
    searchIssueCandidates(client, packageName, dateRange, previousIssueFilter, ISSUE_SEARCH_PAGE_SIZE, 1, issueSearchMaxResultsPerOrder),
    searchIssueCandidates(client, packageName, historicalRange, historicalIssueFilter, ISSUE_SEARCH_PAGE_SIZE, 0, issueSearchMaxResultsPerOrder),
    searchIssueCandidates(
      client,
      packageName,
      dateRange,
      addUserPerceivedFilter(currentIssueFilter),
      ISSUE_SEARCH_PAGE_SIZE,
      0,
      issueSearchMaxResultsPerOrder
    ),
    searchIssueCandidates(
      client,
      packageName,
      dateRange,
      addUserPerceivedFilter(previousIssueFilter),
      ISSUE_SEARCH_PAGE_SIZE,
      0,
      issueSearchMaxResultsPerOrder
    ),
    searchIssueCandidates(
      client,
      packageName,
      historicalRange,
      addUserPerceivedFilter(historicalIssueFilter),
      ISSUE_SEARCH_PAGE_SIZE,
      0,
      issueSearchMaxResultsPerOrder
    )
  ]);
  const detection = detectReleaseRegressions({
    currentMetricGroups,
    previousMetricGroups,
    currentIssues: currentIssueSearch.issues,
    previousIssues: previousIssueSearch.issues,
    historicalIssues: historicalIssueSearch.issues,
    issueSearchCompleteness: {
      current: !currentIssueSearch.capped,
      previous: !previousIssueSearch.capped,
      historical: !historicalIssueSearch.capped
    },
    currentUserPerceivedIssues: currentUserPerceivedIssueSearch.issues,
    previousUserPerceivedIssues: previousUserPerceivedIssueSearch.issues,
    historicalUserPerceivedIssues: historicalUserPerceivedIssueSearch.issues,
    limit: input.limit
  });
  const summary = releaseComparisonSummary(packageName, input, detection.metrics, detection.issues);
  const issueSearchWarnings = [
    { label: "current release issue search", result: currentIssueSearch, suppressesAbsenceLabels: true },
    { label: "previous release issue search", result: previousIssueSearch, suppressesAbsenceLabels: true },
    { label: "historical issue search", result: historicalIssueSearch, suppressesAbsenceLabels: true },
    {
      label: "current release user-perceived issue search",
      result: currentUserPerceivedIssueSearch,
      suppressesAbsenceLabels: false
    },
    {
      label: "previous release user-perceived issue search",
      result: previousUserPerceivedIssueSearch,
      suppressesAbsenceLabels: false
    },
    {
      label: "historical user-perceived issue search",
      result: historicalUserPerceivedIssueSearch,
      suppressesAbsenceLabels: false
    }
  ];

  return compareReleasesOutputSchema.parse({
    packageName,
    track: input.track,
    currentVersionCodes: input.currentVersionCodes,
    previousVersionCodes: input.previousVersionCodes,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive),
      previousStartDate: historicalRange.startDate,
      previousEndDateExclusive: historicalRange.endDateExclusive,
      aggregationPeriod: RELEASE_HEALTH_AGGREGATION_PERIOD,
      timeZone: PLAY_VITALS_TIME_ZONE
    },
    filters: {
      type: input.type,
      limit: input.limit
    },
    metrics: detection.metrics,
    issues: detection.issues,
    summary,
    warnings: releaseComparisonWarnings(detection.metrics, detection.issues, issueSearchWarnings, issueSearchMaxResultsPerOrder)
  });
}

export function formatCompareReleasesMarkdown(output: CompareReleasesOutput): string {
  const issueRegressions = regressionIssues(output);
  const metricRows = output.metrics.map(formatMetricRegressionRow).join("\n");

  return [
    "# Play Store Release Regression Report",
    "",
    `Package: ${output.packageName}`,
    `Track: ${output.track}`,
    `Current release: ${output.currentVersionCodes.join(", ")}`,
    `Previous release: ${output.previousVersionCodes.join(", ")}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.timeZone}`,
    `Historical window: ${output.dateRange.previousStartDate} to ${output.dateRange.previousEndDateExclusive} (exclusive)`,
    "",
    `**Answer:** ${output.summary.answer}`,
    "",
    "## Next Actions",
    "",
    ...output.summary.nextActions.map((action) => `- ${action}`),
    "",
    "## Metric Deltas",
    "",
    "| Signal | Severity | Current rate | Previous rate | Rate delta | Current user-perceived | Previous user-perceived | User-perceived delta | Current user-days | Previous user-days |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    metricRows || "| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |",
    "",
    "## What Got Worse",
    "",
    issueRegressions.length === 0
      ? "_No new, resurfaced, or worsened crash/ANR issues were detected._"
      : [
          "| Severity | Change | Type | Issue | Current users | Previous users | User delta | Current events | Previous events | Event delta | Cause / location |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...issueRegressions.map(formatIssueChangeRow)
        ].join("\n"),
    "",
    "## Fixed Or No Longer Observed",
    "",
    output.issues.fixedIssues.length === 0
      ? "_No previously observed issues disappeared in this comparison window._"
      : [
          "| Issue | Type | Previous users | Previous events | Cause / location |",
          "| --- | --- | --- | --- | --- |",
          ...output.issues.fixedIssues.map(formatFixedIssueRow)
        ].join("\n"),
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function queryReleaseMetricGroups(
  client: PlayReportingClient,
  packageName: string,
  versionCodes: string[],
  dateRange: DateRange
): Promise<ReleaseHealthMetricGroup[]> {
  return Promise.all(
    RELEASE_HEALTH_METRICS.map(async (metricConfig) =>
      aggregateReleaseHealthMetricGroup(
        metricConfig,
        await queryReleaseMetricRows(client, packageName, versionCodes, dateRange, metricConfig),
        []
      )
    )
  );
}

function queryReleaseMetricRows(
  client: PlayReportingClient,
  packageName: string,
  versionCodes: string[],
  dateRange: DateRange,
  metricConfig: ReleaseHealthMetricConfig
): Promise<ReleaseHealthMetricInputRow[]> {
  return versionCodes.reduce<Promise<ReleaseHealthMetricInputRow[]>>(async (pendingRows, versionCode) => {
    const rows = await pendingRows;
    return [...rows, ...(await queryReleaseMetricRowsForVersionCode(client, packageName, dateRange, metricConfig, versionCode))];
  }, Promise.resolve([]));
}

async function queryReleaseMetricRowsForVersionCode(
  client: PlayReportingClient,
  packageName: string,
  dateRange: DateRange,
  metricConfig: ReleaseHealthMetricConfig,
  versionCode: string
): Promise<ReleaseHealthMetricInputRow[]> {
  const rows: ReleaseHealthMetricInputRow[] = [];
  let pageToken: string | undefined;

  do {
    const result = await client.queryMetrics(packageName, {
      metricSet: metricConfig.metricSet,
      metrics: [metricConfig.rateMetric, metricConfig.userPerceivedRateMetric, "distinctUsers"],
      timelineSpec: buildReleaseHealthTimelineSpec(dateRange.startDate, dateRange.endDateExclusive),
      filter: buildVersionCodeFilter(versionCode),
      pageSize: 100_000,
      pageToken
    });

    rows.push(...result.rows.map((row) => ({ versionCode, row })));
    pageToken = result.nextPageToken;
  } while (pageToken);

  return rows;
}

async function searchIssueCandidates(
  client: PlayReportingClient,
  packageName: string,
  dateRange: DateRange,
  filter: string,
  pageSize: number,
  sampleErrorReportLimit: number,
  maxResultsPerOrder: number
): Promise<IssueSearchResult> {
  const orderResults = await Promise.all(
    ["distinctUsers desc", "errorReportCount desc"].map((orderBy) =>
      searchIssueCandidatesForOrder(
        client,
        packageName,
        dateRange,
        filter,
        orderBy,
        pageSize,
        sampleErrorReportLimit,
        maxResultsPerOrder
      )
    )
  );

  return {
    issues: dedupeIssues(orderResults.flatMap((result) => result.issues)),
    capped: orderResults.some((result) => result.capped),
    fetchedResults: orderResults.reduce((sum, result) => sum + result.fetchedResults, 0)
  };
}

async function searchIssueCandidatesForOrder(
  client: PlayReportingClient,
  packageName: string,
  dateRange: DateRange,
  filter: string,
  orderBy: string,
  pageSize: number,
  sampleErrorReportLimit: number,
  maxResultsPerOrder: number
): Promise<IssueSearchResult> {
  const cappedMaxResults = Math.max(1, maxResultsPerOrder);
  const issues: PlayErrorIssue[] = [];
  let capped = false;
  let pageToken: string | undefined;

  do {
    const remaining = cappedMaxResults - issues.length;
    const page = await client.searchIssues(packageName, {
      interval: dateRange,
      filter,
      orderBy,
      pageSize: Math.min(pageSize, remaining),
      pageToken,
      sampleErrorReportLimit
    });

    issues.push(...page.reports.slice(0, remaining));

    if (!page.nextPageToken) {
      pageToken = undefined;
    } else if (issues.length >= cappedMaxResults) {
      capped = true;
      pageToken = undefined;
    } else {
      pageToken = page.nextPageToken;
    }
  } while (pageToken);

  return {
    issues,
    capped,
    fetchedResults: issues.length
  };
}

function releaseComparisonSummary(
  packageName: string,
  input: CompareReleasesInput,
  metrics: ReleaseMetricRegression[],
  issues: CompareReleasesOutput["issues"]
): CompareReleasesOutput["summary"] {
  const issueRegressions = [...issues.newIssues, ...issues.resurfacedIssues, ...issues.worsenedIssues];
  const metricRegressions = metrics.filter(metricGotWorse);
  const regressions = [...issueRegressions, ...metricRegressions];
  const highestSeverity = highestSeverityFor(regressions.map((item) => item.severity));
  const highRiskCount = regressions.filter((item) => item.severity === "high-risk").length;
  const investigateCount = regressions.filter((item) => item.severity === "investigate").length;
  const monitorCount = regressions.filter((item) => item.severity === "monitor").length;

  return {
    answer: comparisonAnswer(issueRegressions, metricRegressions, highestSeverity),
    highestSeverity,
    regressionCount: issueRegressions.length + metricRegressions.length,
    metricRegressionCount: metricRegressions.length,
    fixedCount: issues.fixedIssues.length,
    highRiskCount,
    investigateCount,
    monitorCount,
    nextActions: comparisonNextActions(packageName, input, issueRegressions, metricRegressions, highestSeverity)
  };
}

function comparisonAnswer(
  issueRegressions: RegressionIssueChange[],
  metricRegressions: ReleaseMetricRegression[],
  highestSeverity: RegressionSeverity
): string {
  if (issueRegressions.length === 0 && metricRegressions.length === 0) {
    return "No crash/ANR issue or release-health metric regressions were detected for the requested window.";
  }

  return [
    `${issueRegressions.length} crash/ANR issue change(s) got worse`,
    `${metricRegressions.length} release-health metric signal(s) worsened`,
    `highest severity is ${highestSeverity}`
  ].join("; ") + ".";
}

function comparisonNextActions(
  packageName: string,
  input: CompareReleasesInput,
  issueRegressions: RegressionIssueChange[],
  metricRegressions: ReleaseMetricRegression[],
  highestSeverity: RegressionSeverity
): string[] {
  const actions: string[] = [];
  const topIssue = [...issueRegressions].sort(compareRegressionsBySeverity)[0];
  const topMetric = [...metricRegressions].sort(compareMetricRegressionsBySeverity)[0];

  if (topIssue) {
    actions.push(
      `Fetch sample reports for the top ${topIssue.severity} issue: scripts/playstore reports list --package ${packageName} --issue-id ${topIssue.issueId} --version-code ${input.currentVersionCodes.join(",")} --start-date ${input.startDate} --end-date ${input.endDateExclusive} --format markdown`
    );
  }

  if (topMetric) {
    actions.push(
      `Slice the ${topMetric.signal} metric regression by device and API level: scripts/playstore health release --package ${packageName} --track ${input.track} --version-code ${input.currentVersionCodes.join(",")} --start-date ${input.startDate} --end-date ${input.endDateExclusive} --dimension device-model --dimension api-level --format markdown`
    );
  }

  if (highestSeverity === "high-risk") {
    actions.push("Before expanding rollout, have a release owner confirm scope, owner, and mitigation in Play Console.");
  } else if (highestSeverity === "investigate") {
    actions.push("Assign the highest-severity regression to an owner and re-run this comparison after the next reporting refresh.");
  } else if (issueRegressions.length > 0 || metricRegressions.length > 0) {
    actions.push("Keep monitoring low-volume regressions and escalate if user-perceived impact appears.");
  } else {
    actions.push("Continue normal monitoring and re-run the comparison for the next release-health window.");
  }

  return dedupe(actions);
}

function releaseComparisonWarnings(
  metrics: ReleaseMetricRegression[],
  issues: CompareReleasesOutput["issues"],
  issueSearchWarnings: IssueSearchWarning[],
  issueSearchMaxResultsPerOrder: number
): string[] {
  const warnings: string[] = [];

  if (metrics.some((metric) => metric.previous.dataPoints === 0)) {
    warnings.push("One or more previous-release metric groups had no returned rows, so metric deltas may be incomplete.");
  }

  if (issues.lowVolumeMonitorCount > 0) {
    warnings.push(
      `${issues.lowVolumeMonitorCount} issue change(s) were labeled monitor because current volume is below the noise threshold.`
    );
  }

  if (
    issues.newIssues.length === 0 &&
    issues.resurfacedIssues.length === 0 &&
    issues.worsenedIssues.length === 0 &&
    issues.fixedIssues.length === 0
  ) {
    warnings.push("No crash or ANR issue changes were returned for the requested release comparison.");
  }

  for (const warning of issueSearchWarnings) {
    if (warning.result.capped) {
      const impact = warning.suppressesAbsenceLabels
        ? "absence-based labels that depend on this search were suppressed."
        : "user-perceived impact counts may be incomplete for returned issues.";

      warnings.push(`${titleCase(warning.label)} reached the ${issueSearchMaxResultsPerOrder}-result per-sort cap before all pages were read; ${impact}`);
    }
  }

  return warnings;
}

function resolveRequiredDateRange(options: Pick<CompareReleasesOptions, "startDate" | "endDate" | "days">): DateRange {
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
    "A release comparison date range is required.",
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

function addUserPerceivedFilter(filter: string): string {
  return [filter, "isUserPerceived"].filter(Boolean).join(" AND ");
}

function metricGotWorse(metric: ReleaseMetricRegression): boolean {
  return metric.deltas.rate.worsened || metric.deltas.userPerceivedRate.worsened;
}

function regressionIssues(output: CompareReleasesOutput): RegressionIssueChange[] {
  return [...output.issues.newIssues, ...output.issues.resurfacedIssues, ...output.issues.worsenedIssues].sort(
    compareRegressionsBySeverity
  );
}

function compareRegressionsBySeverity(left: RegressionIssueChange, right: RegressionIssueChange): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    right.deltas.affectedUsersDelta - left.deltas.affectedUsersDelta ||
    right.deltas.eventCountDelta - left.deltas.eventCountDelta ||
    left.issueId.localeCompare(right.issueId)
  );
}

function compareMetricRegressionsBySeverity(left: ReleaseMetricRegression, right: ReleaseMetricRegression): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    numberValue(right.deltas.userPerceivedRate.absoluteDelta) - numberValue(left.deltas.userPerceivedRate.absoluteDelta) ||
    numberValue(right.deltas.rate.absoluteDelta) - numberValue(left.deltas.rate.absoluteDelta)
  );
}

function highestSeverityFor(severities: RegressionSeverity[]): RegressionSeverity {
  return severities.reduce<RegressionSeverity>(
    (highest, severity) => (severityRank(severity) > severityRank(highest) ? severity : highest),
    "monitor"
  );
}

function severityRank(severity: RegressionSeverity): number {
  if (severity === "high-risk") {
    return 2;
  }

  if (severity === "investigate") {
    return 1;
  }

  return 0;
}

function formatMetricRegressionRow(metric: ReleaseMetricRegression): string {
  return [
    titleCase(metric.signal),
    metric.severity,
    formatRatio(metric.current.rate),
    formatRatio(metric.previous.rate),
    formatPercentagePointDelta(metric.deltas.rate.absoluteDelta),
    formatRatio(metric.current.userPerceivedRate),
    formatRatio(metric.previous.userPerceivedRate),
    formatPercentagePointDelta(metric.deltas.userPerceivedRate.absoluteDelta),
    formatNumber(metric.current.distinctUserDays),
    formatNumber(metric.previous.distinctUserDays)
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatIssueChangeRow(issue: RegressionIssueChange): string {
  return [
    issue.severity,
    issue.classification,
    issue.type,
    issue.issueId,
    formatNumber(issue.current.affectedUsers),
    formatNumber(issue.previous.affectedUsers),
    formatSignedNumber(issue.deltas.affectedUsersDelta),
    formatNumber(issue.current.eventCount),
    formatNumber(issue.previous.eventCount),
    formatSignedNumber(issue.deltas.eventCountDelta),
    [issue.cause, issue.location].filter(Boolean).join(" @ ") || "_unknown_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatFixedIssueRow(issue: RegressionIssueChange): string {
  return [
    issue.issueId,
    issue.type,
    formatNumber(issue.previous.affectedUsers),
    formatNumber(issue.previous.eventCount),
    [issue.cause, issue.location].filter(Boolean).join(" @ ") || "_unknown_"
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatRatio(value: number | null): string {
  return value === null ? "_missing_" : `${(value * 100).toFixed(3)}%`;
}

function formatPercentagePointDelta(value: number | null): string {
  return value === null ? "_missing_" : `${formatSignedNumber(Number((value * 100).toFixed(3)))}pp`;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatNumber(value: number | null): string {
  return value === null ? "_missing_" : new Intl.NumberFormat("en-US").format(value);
}

function numberValue(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
