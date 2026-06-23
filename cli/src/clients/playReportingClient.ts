import type {
  PlayAnomaly,
  PlayErrorIssue,
  PlayErrorReport,
  PlayMetricDateTime,
  PlayMetricQuery,
  PlayMetricResult,
  PlayReportPage
} from "../schemas/playApiTypes.js";
import { dateOnlyToQueryParams, PLAY_VITALS_TIME_ZONE } from "../utils/dateRanges.js";
import { requestGooglePlay, type GooglePlayRequestClient } from "./request.js";

const REPORTING_BASE_URL = "https://playdeveloperreporting.googleapis.com/v1beta1";

interface ReportingMetricsResponse {
  rows?: Array<{
    aggregationPeriod?: string;
    startTime?: PlayMetricDateTime;
    dimensions?: Array<{
      dimension?: string;
      stringValue?: string;
      int64Value?: string;
    }>;
    metrics?: Array<{
      metric?: string;
      decimalValue?: {
        value?: string;
      };
    }>;
  }>;
  nextPageToken?: string;
}

interface ReportingIssuesResponse {
  errorIssues?: Array<{
    name?: string;
    type?: string;
    cause?: string;
    location?: string;
    errorReportCount?: string;
    distinctUsers?: string;
    distinctUsersPercent?: {
      value?: string;
    };
    firstAppVersion?: {
      versionCode?: string;
    };
    lastAppVersion?: {
      versionCode?: string;
    };
    firstOsVersion?: {
      apiLevel?: string;
    };
    lastOsVersion?: {
      apiLevel?: string;
    };
    lastErrorReportTime?: string;
    sampleErrorReports?: string[];
    issueUri?: string;
  }>;
  nextPageToken?: string;
}

interface ReportingReportsResponse {
  errorReports?: Array<{
    name?: string;
    issue?: string;
    type?: string;
    appVersion?: {
      versionCode?: string;
    };
    osVersion?: {
      apiLevel?: string;
    };
    deviceModel?: {
      marketingName?: string;
      deviceUri?: string;
      deviceId?: {
        buildBrand?: string;
        buildDevice?: string;
      };
    };
    eventTime?: string;
    reportText?: string;
    vcsInformation?: string;
  }>;
  nextPageToken?: string;
}

interface ReportingAnomaliesResponse {
  anomalies?: Array<{
    name?: string;
    metricSet?: string;
    timelineSpec?: {
      aggregationPeriod?: string;
      startTime?: PlayMetricDateTime;
      endTime?: PlayMetricDateTime;
    };
    dimensions?: Array<{
      dimension?: string;
      stringValue?: string;
      int64Value?: string;
      valueLabel?: string;
    }>;
    metric?: {
      metric?: string;
      decimalValue?: {
        value?: string;
      };
      decimalValueConfidenceInterval?: {
        lowerBound?: {
          value?: string;
        };
        upperBound?: {
          value?: string;
        };
      };
    };
  }>;
  nextPageToken?: string;
}

export interface SearchIssuesOptions {
  interval?: ReportingDateInterval;
  filter?: string;
  orderBy?: string;
  sampleErrorReportLimit?: number;
  pageSize?: number;
  pageToken?: string;
}

export interface SearchReportsOptions {
  interval?: ReportingDateInterval;
  filter?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListAnomaliesOptions {
  filter?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ReportingDateInterval {
  startDate: string;
  endDateExclusive: string;
  timeZone?: string;
}

export interface PlayReportingClient {
  queryMetrics(packageName: string, query: PlayMetricQuery): Promise<PlayMetricResult>;
  searchIssues(packageName: string, options?: SearchIssuesOptions): Promise<PlayReportPage<PlayErrorIssue>>;
  searchReports(packageName: string, options?: SearchReportsOptions): Promise<PlayReportPage<PlayErrorReport>>;
  listAnomalies(packageName: string, options?: ListAnomaliesOptions): Promise<PlayReportPage<PlayAnomaly>>;
}

export function createPlayReportingClient(requestClient: GooglePlayRequestClient): PlayReportingClient {
  return {
    async queryMetrics(packageName: string, query: PlayMetricQuery): Promise<PlayMetricResult> {
      const response = await requestGooglePlay<ReportingMetricsResponse>(requestClient, {
        method: "POST",
        url: `${appUrl(packageName)}/${encodeURIComponent(query.metricSet)}:query`,
        data: compactRequestBody({
          dimensions: query.dimensions,
          metrics: query.metrics,
          timelineSpec: query.timelineSpec,
          filter: query.filter,
          pageSize: query.pageSize,
          pageToken: query.pageToken
        })
      });

      return {
        rows: (response.rows ?? []).map((row) => ({
          aggregationPeriod: row.aggregationPeriod,
          startTime: row.startTime,
          dimensions: Object.fromEntries(
            (row.dimensions ?? [])
              .filter((item) => item.dimension)
              .map((item) => [item.dimension as string, dimensionValue(item)])
          ),
          metrics: Object.fromEntries(
            (row.metrics ?? []).flatMap((item) => {
              const value = Number(item.decimalValue?.value);

              return item.metric && Number.isFinite(value) ? [[item.metric, value] as const] : [];
            })
          )
        })),
        nextPageToken: response.nextPageToken
      };
    },

    async searchIssues(
      packageName: string,
      options: SearchIssuesOptions = {}
    ): Promise<PlayReportPage<PlayErrorIssue>> {
      const response = await requestGooglePlay<ReportingIssuesResponse>(requestClient, {
        method: "GET",
        url: `${appUrl(packageName)}/errorIssues:search`,
        params: searchIssueParams(options)
      });

      return {
        reports: (response.errorIssues ?? [])
          .filter((issue) => issue.name)
          .map((issue) => ({
            name: issue.name as string,
            type: normalizeIssueType(issue.type),
            cause: issue.cause,
            location: issue.location,
            errorReportCount: issue.errorReportCount,
            distinctUsers: issue.distinctUsers,
            distinctUsersPercent: issue.distinctUsersPercent?.value,
            firstAppVersion: issue.firstAppVersion,
            lastAppVersion: issue.lastAppVersion,
            firstOsVersion: issue.firstOsVersion,
            lastOsVersion: issue.lastOsVersion,
            lastErrorReportTime: issue.lastErrorReportTime,
            sampleErrorReports: issue.sampleErrorReports,
            issueUri: issue.issueUri
          })),
        nextPageToken: response.nextPageToken
      };
    },

    async searchReports(
      packageName: string,
      options: SearchReportsOptions = {}
    ): Promise<PlayReportPage<PlayErrorReport>> {
      const response = await requestGooglePlay<ReportingReportsResponse>(requestClient, {
        method: "GET",
        url: `${appUrl(packageName)}/errorReports:search`,
        params: searchReportParams(options)
      });

      return {
        reports: (response.errorReports ?? [])
          .filter((report) => report.name)
          .map((report) => ({
            name: report.name as string,
            issue: report.issue,
            type: normalizeIssueType(report.type),
            appVersion: report.appVersion,
            osVersion: report.osVersion,
            deviceModel: report.deviceModel,
            eventTime: report.eventTime,
            reportText: report.reportText,
            vcsInformation: report.vcsInformation
          })),
        nextPageToken: response.nextPageToken
      };
    },

    async listAnomalies(
      packageName: string,
      options: ListAnomaliesOptions = {}
    ): Promise<PlayReportPage<PlayAnomaly>> {
      const response = await requestGooglePlay<ReportingAnomaliesResponse>(requestClient, {
        method: "GET",
        url: `${appUrl(packageName)}/anomalies`,
        params: compactParams({
          filter: options.filter,
          pageSize: options.pageSize,
          pageToken: options.pageToken
        })
      });

      return {
        reports: (response.anomalies ?? [])
          .filter((anomaly) => anomaly.name)
          .map((anomaly) => ({
            name: anomaly.name as string,
            metricSet: anomaly.metricSet,
            timelineSpec: anomaly.timelineSpec,
            dimensions: anomaly.dimensions,
            metric: anomaly.metric
          })),
        nextPageToken: response.nextPageToken
      };
    }
  };
}

function appUrl(packageName: string): string {
  return `${REPORTING_BASE_URL}/apps/${encodeURIComponent(packageName)}`;
}

function dimensionValue(dimension: { stringValue?: string; int64Value?: string }): string {
  return dimension.stringValue ?? dimension.int64Value ?? "";
}

function searchIssueParams(options: SearchIssuesOptions): Record<string, string | number> {
  return compactParams({
    ...intervalParams(options.interval),
    filter: options.filter,
    orderBy: options.orderBy,
    sampleErrorReportLimit: options.sampleErrorReportLimit,
    pageSize: options.pageSize,
    pageToken: options.pageToken
  });
}

function searchReportParams(options: SearchReportsOptions): Record<string, string | number> {
  return compactParams({
    ...intervalParams(options.interval),
    filter: options.filter,
    pageSize: options.pageSize,
    pageToken: options.pageToken
  });
}

function intervalParams(interval: ReportingDateInterval | undefined): Record<string, string | number> {
  if (!interval) {
    return {};
  }

  const timeZone = interval.timeZone ?? PLAY_VITALS_TIME_ZONE;

  return {
    ...dateOnlyToQueryParams("interval.startTime", interval.startDate, timeZone),
    ...dateOnlyToQueryParams("interval.endTime", interval.endDateExclusive, timeZone)
  };
}

function compactRequestBody(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, unknown] => entry[1] !== undefined));
}

function compactParams<TValue extends string | number | boolean>(
  record: Record<string, TValue | undefined>
): Record<string, TValue> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, TValue] => entry[1] !== undefined));
}

function normalizeIssueType(type: string | undefined): "crash" | "anr" | "non_fatal" | undefined {
  if (type === "CRASH" || type === "crash") {
    return "crash";
  }

  if (type === "APPLICATION_NOT_RESPONDING" || type === "ANR" || type === "anr") {
    return "anr";
  }

  if (type === "NON_FATAL" || type === "non_fatal") {
    return "non_fatal";
  }

  return undefined;
}
