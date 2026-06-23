import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayReportingClient, type PlayReportingClient } from "../clients/playReportingClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import {
  aggregateReleaseHealthMetricGroup,
  buildReleaseHealthTimelineSpec,
  buildVersionCodeFilter,
  dateRangeDays,
  RELEASE_HEALTH_AGGREGATION_PERIOD,
  RELEASE_HEALTH_METRICS,
  RELEASE_HEALTH_TIME_ZONE,
  type ReleaseHealthMetricConfig,
  type ReleaseHealthMetricInputRow
} from "../domain/releaseHealth.js";
import {
  healthDimensionSchema,
  healthReleaseInputSchema,
  type HealthDimension,
  type HealthReleaseInput
} from "../schemas/cliInputs.js";
import { releaseHealthOutputSchema, type ReleaseHealthOutput } from "../schemas/cliOutputs.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface HealthReleaseOptions {
  package?: string;
  track: string;
  versionCode?: string[];
  startDate?: string;
  endDate?: string;
  days?: number;
  dimension?: string[];
  format: string;
}

export function createHealthCommand(): Command {
  const command = new Command("health");

  command.description("Inspect read-only Google Play vitals metrics for releases.");
  command.addCommand(createHealthReleaseCommand());

  return command;
}

export function createHealthReleaseCommand(): Command {
  const command = new Command("release");

  command
    .description("Report crash and ANR health for release version codes over a date range.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option("--track <track>", "Track name used for release context.", "production")
    .option(
      "--version-code <versionCode>",
      "Version code to include. Repeat the option or pass comma-separated values.",
      collectCsvOption,
      [] as string[]
    )
    .option("--start-date <date>", "Start date for daily metrics, YYYY-MM-DD.")
    .option("--end-date <date>", "End date for daily metrics, exclusive, YYYY-MM-DD.")
    .option("--days <days>", "Number of days ending at --end-date when --start-date is omitted.", parsePositiveInteger)
    .option(
      "--dimension <dimension>",
      "Break down rows by api-level, device-model, country, or app-version. Repeat for multiple dimensions.",
      collectCsvOption,
      [] as string[]
    )
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: HealthReleaseOptions) => {
      const input = healthReleaseInputSchema.parse({
        packageName: options.package,
        track: options.track,
        versionCodes: normalizeVersionCodes(options.versionCode ?? []),
        ...resolveDateRange(options),
        dimensions: normalizeDimensions(options.dimension ?? []),
        format: options.format
      });
      const output = await getReleaseHealth(input);

      if (input.format === "markdown") {
        printMarkdown(formatReleaseHealthMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function getReleaseHealth(
  input: HealthReleaseInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayReportingClient;
  } = {}
): Promise<ReleaseHealthOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayReportingClient(await createAuthenticatedClient(config));
  const metricGroups = await Promise.all(
    RELEASE_HEALTH_METRICS.map(async (metricConfig) =>
      aggregateReleaseHealthMetricGroup(
        metricConfig,
        await queryReleaseMetricRows(client, packageName, input, metricConfig),
        input.dimensions
      )
    )
  );

  return releaseHealthOutputSchema.parse({
    packageName,
    track: input.track,
    versionCodes: input.versionCodes,
    dateRange: {
      startDate: input.startDate,
      endDateExclusive: input.endDateExclusive,
      days: dateRangeDays(input.startDate, input.endDateExclusive),
      aggregationPeriod: RELEASE_HEALTH_AGGREGATION_PERIOD,
      timeZone: RELEASE_HEALTH_TIME_ZONE
    },
    dimensions: input.dimensions,
    metricGroups,
    warnings: metricGroups.flatMap((group) => healthWarnings(group))
  });
}

export function formatReleaseHealthMarkdown(output: ReleaseHealthOutput): string {
  const summaryRows = output.metricGroups.map(formatMetricGroupSummaryRow).join("\n");
  const sliceRows = output.metricGroups.flatMap(formatMetricGroupSliceRows).join("\n");

  return [
    "# Play Store Release Health",
    "",
    `Package: ${output.packageName}`,
    `Track: ${output.track}`,
    `Version codes: ${output.versionCodes.join(", ")}`,
    `Date range: ${output.dateRange.startDate} to ${output.dateRange.endDateExclusive} (exclusive), ${output.dateRange.timeZone}`,
    "",
    "| Signal | Rate | User-perceived rate | Distinct user-days | Data points | Missing metric rows |",
    "| --- | --- | --- | --- | --- | --- |",
    summaryRows,
    "",
    "## Dimension slices",
    "",
    output.dimensions.length === 0
      ? "_No optional dimensions requested._"
      : ["| Signal | Dimensions | Rate | User-perceived rate | Distinct user-days | Data points |", "| --- | --- | --- | --- | --- | --- |", sliceRows || "| _none_ | _none_ | _n/a_ | _n/a_ | _n/a_ | 0 |"].join("\n")
  ].join("\n");
}

function queryReleaseMetricRows(
  client: PlayReportingClient,
  packageName: string,
  input: HealthReleaseInput,
  metricConfig: ReleaseHealthMetricConfig
): Promise<ReleaseHealthMetricInputRow[]> {
  return input.versionCodes.reduce<Promise<ReleaseHealthMetricInputRow[]>>(async (pendingRows, versionCode) => {
    const rows = await pendingRows;
    return [...rows, ...(await queryReleaseMetricRowsForVersionCode(client, packageName, input, metricConfig, versionCode))];
  }, Promise.resolve([]));
}

async function queryReleaseMetricRowsForVersionCode(
  client: PlayReportingClient,
  packageName: string,
  input: HealthReleaseInput,
  metricConfig: ReleaseHealthMetricConfig,
  versionCode: string
): Promise<ReleaseHealthMetricInputRow[]> {
  const rows: ReleaseHealthMetricInputRow[] = [];
  let pageToken: string | undefined;

  do {
    const result = await client.queryMetrics(packageName, {
      metricSet: metricConfig.metricSet,
      dimensions: input.dimensions.length > 0 ? input.dimensions : undefined,
      metrics: [metricConfig.rateMetric, metricConfig.userPerceivedRateMetric, "distinctUsers"],
      timelineSpec: buildReleaseHealthTimelineSpec(input.startDate, input.endDateExclusive),
      filter: buildVersionCodeFilter(versionCode),
      pageSize: 100_000,
      pageToken
    });

    rows.push(...result.rows.map((row) => ({ versionCode, row })));
    pageToken = result.nextPageToken;
  } while (pageToken);

  return rows;
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

function normalizeDimensions(values: string[]): HealthDimension[] {
  return dedupe(values.flatMap(splitCsv).map(normalizeDimension)).map((dimension) => healthDimensionSchema.parse(dimension));
}

function normalizeDimension(value: string): HealthDimension {
  const normalized = value.trim().toLowerCase();

  if (normalized === "api-level" || normalized === "apilevel") {
    return "apiLevel";
  }

  if (normalized === "device-model" || normalized === "devicemodel") {
    return "deviceModel";
  }

  if (normalized === "country" || normalized === "country-code" || normalized === "countrycode") {
    return "countryCode";
  }

  if (normalized === "app-version" || normalized === "appversion" || normalized === "version-code") {
    return "versionCode";
  }

  return healthDimensionSchema.parse(value);
}

function resolveDateRange(options: HealthReleaseOptions): Pick<HealthReleaseInput, "startDate" | "endDateExclusive"> {
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
    "A release health date range is required.",
    "Pass --start-date and --end-date, or pass --days with --end-date. --end-date is exclusive."
  );
}

function splitCsv(value: string): string[] {
  return value.split(",").map((entry) => entry.trim());
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}

export function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected a positive whole number, received "${value}".`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive safe integer, received "${value}".`);
  }

  return parsed;
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

function healthWarnings(group: ReleaseHealthOutput["metricGroups"][number]): string[] {
  return group.series.length === 0
    ? [`No ${group.signal} metric rows were returned for the requested release and date range.`]
    : [];
}

function formatMetricGroupSummaryRow(group: ReleaseHealthOutput["metricGroups"][number]): string {
  return [
    titleCase(group.signal),
    formatRatio(group.summary.rate.value),
    formatRatio(group.summary.userPerceivedRate.value),
    formatNumber(group.summary.distinctUsers.userDays),
    `${group.summary.rate.dataPoints}/${group.missingData.rows}`,
    String(group.missingData.rowsMissingAnyMetric)
  ]
    .map(escapeMarkdownTableCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function formatMetricGroupSliceRows(group: ReleaseHealthOutput["metricGroups"][number]): string[] {
  return group.slices.map((slice) =>
    [
      titleCase(group.signal),
      formatDimensions(slice.dimensions),
      formatRatio(slice.summary.rate.value),
      formatRatio(slice.summary.userPerceivedRate.value),
      formatNumber(slice.summary.distinctUsers.userDays),
      String(slice.dataPoints)
    ]
      .map(escapeMarkdownTableCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |")
  );
}

function formatRatio(value: number | null): string {
  return value === null ? "_missing_" : `${(value * 100).toFixed(3)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "_missing_" : new Intl.NumberFormat("en-US").format(value);
}

function formatDimensions(dimensions: Record<string, string>): string {
  return Object.entries(dimensions)
    .map(([key, value]) => `${key}=${value || "_unknown_"}`)
    .join(", ");
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
