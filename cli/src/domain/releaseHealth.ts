import type { HealthDimension } from "../schemas/cliInputs.js";
import type { PlayMetricDateTime, PlayMetricRow } from "../schemas/playApiTypes.js";
import {
  releaseHealthMetricGroupSchema,
  type ReleaseHealthMetricGroup,
  type ReleaseHealthMetricSummary,
  type ReleaseHealthRateSummary,
  type ReleaseHealthSeriesPoint
} from "../schemas/cliOutputs.js";

export const RELEASE_HEALTH_TIME_ZONE = "America/Los_Angeles";
export const RELEASE_HEALTH_AGGREGATION_PERIOD = "DAILY";

export interface ReleaseHealthMetricConfig {
  signal: "crash" | "anr";
  metricSet: string;
  rateMetric: string;
  userPerceivedRateMetric: string;
}

export interface ReleaseHealthMetricInputRow {
  versionCode: string;
  row: PlayMetricRow;
}

export const RELEASE_HEALTH_METRICS: ReleaseHealthMetricConfig[] = [
  {
    signal: "crash",
    metricSet: "crashRateMetricSet",
    rateMetric: "crashRate",
    userPerceivedRateMetric: "userPerceivedCrashRate"
  },
  {
    signal: "anr",
    metricSet: "anrRateMetricSet",
    rateMetric: "anrRate",
    userPerceivedRateMetric: "userPerceivedAnrRate"
  }
];

const DISTINCT_USERS_NOTE =
  "distinctUsers are summed across returned rows as user-days for weighting; do not interpret this as unique users.";

export function buildReleaseHealthTimelineSpec(startDate: string, endDateExclusive: string): Record<string, unknown> {
  return {
    aggregationPeriod: RELEASE_HEALTH_AGGREGATION_PERIOD,
    startTime: dateOnlyToGoogleDateTime(startDate),
    endTime: dateOnlyToGoogleDateTime(endDateExclusive)
  };
}

export function buildVersionCodeFilter(versionCode: string): string {
  return `versionCode = ${versionCode}`;
}

export function dateRangeDays(startDate: string, endDateExclusive: string): number {
  return Math.round((dateOnlyToUtcMs(endDateExclusive) - dateOnlyToUtcMs(startDate)) / 86_400_000);
}

export function aggregateReleaseHealthMetricGroup(
  config: ReleaseHealthMetricConfig,
  rows: ReleaseHealthMetricInputRow[],
  requestedDimensions: HealthDimension[]
): ReleaseHealthMetricGroup {
  const series = rows.map((inputRow) => toSeriesPoint(inputRow, config, requestedDimensions));
  const summary = summarizeSeries(series, config);
  const missingData = summarizeMissingData(series, [
    config.rateMetric,
    config.userPerceivedRateMetric,
    "distinctUsers"
  ]);
  const slices = requestedDimensions.length === 0 ? [] : summarizeSlices(series, config);

  return releaseHealthMetricGroupSchema.parse({
    signal: config.signal,
    metricSet: config.metricSet,
    metricNames: {
      rate: config.rateMetric,
      userPerceivedRate: config.userPerceivedRateMetric,
      distinctUsers: "distinctUsers"
    },
    summary,
    series,
    slices,
    missingData
  });
}

function toSeriesPoint(
  inputRow: ReleaseHealthMetricInputRow,
  config: ReleaseHealthMetricConfig,
  requestedDimensions: HealthDimension[]
): ReleaseHealthSeriesPoint {
  const dimensions = pickDimensions(inputRow.row.dimensions, inputRow.versionCode, requestedDimensions);
  const metrics = {
    [config.rateMetric]: metricValue(inputRow.row, config.rateMetric),
    [config.userPerceivedRateMetric]: metricValue(inputRow.row, config.userPerceivedRateMetric),
    distinctUsers: metricValue(inputRow.row, "distinctUsers")
  };
  const missingMetrics = Object.entries(metrics)
    .filter((entry) => entry[1] === null)
    .map(([metric]) => metric);

  return {
    date: metricDate(inputRow.row.startTime),
    versionCode: inputRow.versionCode,
    dimensions,
    metrics,
    missingMetrics
  };
}

function summarizeSeries(
  series: ReleaseHealthSeriesPoint[],
  config: ReleaseHealthMetricConfig
): ReleaseHealthMetricSummary {
  return {
    rate: summarizeRate(series, config.rateMetric),
    userPerceivedRate: summarizeRate(series, config.userPerceivedRateMetric),
    distinctUsers: summarizeDistinctUsers(series)
  };
}

function summarizeSlices(
  series: ReleaseHealthSeriesPoint[],
  config: ReleaseHealthMetricConfig
): ReleaseHealthMetricGroup["slices"] {
  return [...groupBy(series, (point) => stableDimensionKey(point.dimensions)).entries()]
    .map(([_, points]) => ({
      dimensions: points[0]?.dimensions ?? {},
      summary: summarizeSeries(points, config),
      dataPoints: points.length
    }))
    .sort(compareSlices);
}

function summarizeRate(series: ReleaseHealthSeriesPoint[], metricName: string): ReleaseHealthRateSummary {
  const available = series.filter((point) => point.metrics[metricName] !== null);
  const weighted = available.filter((point) => positiveNumber(point.metrics.distinctUsers));

  if (weighted.length > 0) {
    const totalWeight = weighted.reduce((sum, point) => sum + numberValue(point.metrics.distinctUsers), 0);
    const weightedTotal = weighted.reduce(
      (sum, point) => sum + numberValue(point.metrics[metricName]) * numberValue(point.metrics.distinctUsers),
      0
    );

    return {
      value: weightedTotal / totalWeight,
      unit: "ratio",
      aggregation: "distinctUsersWeightedAverage",
      dataPoints: weighted.length,
      missingPoints: series.length - weighted.length
    };
  }

  if (available.length > 0) {
    return {
      value: available.reduce((sum, point) => sum + numberValue(point.metrics[metricName]), 0) / available.length,
      unit: "ratio",
      aggregation: "arithmeticMean",
      dataPoints: available.length,
      missingPoints: series.length - available.length
    };
  }

  return {
    value: null,
    unit: "ratio",
    aggregation: "unavailable",
    dataPoints: 0,
    missingPoints: series.length
  };
}

function summarizeDistinctUsers(series: ReleaseHealthSeriesPoint[]): ReleaseHealthMetricSummary["distinctUsers"] {
  const available = series.filter((point) => point.metrics.distinctUsers !== null);

  return {
    userDays:
      available.length === 0
        ? null
        : available.reduce((sum, point) => sum + numberValue(point.metrics.distinctUsers), 0),
    dataPoints: available.length,
    missingPoints: series.length - available.length,
    note: DISTINCT_USERS_NOTE
  };
}

function summarizeMissingData(series: ReleaseHealthSeriesPoint[], metricNames: string[]): ReleaseHealthMetricGroup["missingData"] {
  return {
    rows: series.length,
    rowsMissingAnyMetric: series.filter((point) => point.missingMetrics.length > 0).length,
    metrics: Object.fromEntries(
      metricNames.map((metricName) => [
        metricName,
        series.filter((point) => point.metrics[metricName] === null).length
      ])
    )
  };
}

function pickDimensions(
  dimensions: Record<string, string>,
  versionCode: string,
  requestedDimensions: HealthDimension[]
): Record<string, string> {
  return Object.fromEntries(
    requestedDimensions.map((dimension) => [dimension, dimension === "versionCode" ? versionCode : dimensions[dimension] ?? ""])
  );
}

function metricValue(row: PlayMetricRow, metricName: string): number | null {
  const value = row.metrics[metricName];
  return Number.isFinite(value) ? value : null;
}

function metricDate(startTime: PlayMetricDateTime | undefined): string | null {
  if (startTime?.year && startTime.month && startTime.day) {
    return [
      String(startTime.year).padStart(4, "0"),
      String(startTime.month).padStart(2, "0"),
      String(startTime.day).padStart(2, "0")
    ].join("-");
  }

  return null;
}

function dateOnlyToGoogleDateTime(value: string): Record<string, unknown> {
  const [year, month, day] = value.split("-").map(Number);

  return {
    year,
    month,
    day,
    timeZone: {
      id: RELEASE_HEALTH_TIME_ZONE
    }
  };
}

function dateOnlyToUtcMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function numberValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function stableDimensionKey(dimensions: Record<string, string>): string {
  return JSON.stringify(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right)));
}

function groupBy<TValue>(values: TValue[], keyForValue: (value: TValue) => string): Map<string, TValue[]> {
  const groups = new Map<string, TValue[]>();

  for (const value of values) {
    const key = keyForValue(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }

  return groups;
}

function compareSlices(
  left: ReleaseHealthMetricGroup["slices"][number],
  right: ReleaseHealthMetricGroup["slices"][number]
): number {
  const leftRate = left.summary.userPerceivedRate.value ?? left.summary.rate.value ?? -1;
  const rightRate = right.summary.userPerceivedRate.value ?? right.summary.rate.value ?? -1;

  return rightRate - leftRate || stableDimensionKey(left.dimensions).localeCompare(stableDimensionKey(right.dimensions));
}
