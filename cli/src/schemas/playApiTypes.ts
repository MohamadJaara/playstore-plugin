export interface PlayApp {
  packageName: string;
  title?: string;
}

export interface PlayTrack {
  track: string;
  releases: PlayRelease[];
}

export interface PlayRelease {
  name?: string;
  versionCodes: string[];
  status?: string;
  userFraction?: number;
  releaseNotes?: PlayReleaseNote[];
}

export interface PlayReleaseNote {
  language: string;
  text: string;
}

export interface PlayMetricQuery {
  metricSet: string;
  dimensions?: string[];
  metrics?: string[];
  timelineSpec?: unknown;
  filter?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface PlayMetricRow {
  aggregationPeriod?: string;
  startTime?: PlayMetricDateTime;
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export interface PlayMetricResult {
  rows: PlayMetricRow[];
  nextPageToken?: string;
}

export interface PlayTimelineSpec {
  aggregationPeriod?: string;
  startTime?: PlayMetricDateTime;
  endTime?: PlayMetricDateTime;
}

export interface PlayDimensionValue {
  dimension?: string;
  stringValue?: string;
  int64Value?: string;
  valueLabel?: string;
}

export interface PlayMetricValue {
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
}

export interface PlayAnomaly {
  name: string;
  metricSet?: string;
  timelineSpec?: PlayTimelineSpec;
  dimensions?: PlayDimensionValue[];
  metric?: PlayMetricValue;
}

export interface PlayMetricDateTime {
  year?: number;
  month?: number;
  day?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  nanos?: number;
  utcOffset?: string;
  timeZone?: {
    id?: string;
    version?: string;
  };
}

export type PlayIssueType = "crash" | "anr" | "non_fatal";

export interface PlayErrorIssue {
  name: string;
  type?: PlayIssueType;
  cause?: string;
  location?: string;
  errorReportCount?: string;
  distinctUsers?: string;
  distinctUsersPercent?: string;
  firstAppVersion?: PlayAppVersion;
  lastAppVersion?: PlayAppVersion;
  firstOsVersion?: PlayOsVersion;
  lastOsVersion?: PlayOsVersion;
  lastErrorReportTime?: string;
  sampleErrorReports?: string[];
  issueUri?: string;
}

export interface PlayErrorReport {
  name: string;
  issue?: string;
  type?: PlayIssueType;
  appVersion?: PlayAppVersion;
  osVersion?: PlayOsVersion;
  deviceModel?: PlayDeviceModelSummary;
  eventTime?: string;
  reportText?: string;
  vcsInformation?: string;
}

export interface PlayAppVersion {
  versionCode?: string;
}

export interface PlayOsVersion {
  apiLevel?: string;
}

export interface PlayDeviceModelSummary {
  marketingName?: string;
  deviceUri?: string;
  deviceId?: {
    buildBrand?: string;
    buildDevice?: string;
  };
}

export interface PlayReportPage<TReport> {
  reports: TReport[];
  nextPageToken?: string;
}

export interface PlayReview {
  reviewId: string;
  authorName?: string;
  comments: PlayReviewComment[];
}

export interface PlayReviewComment {
  userComment?: PlayReviewUserComment;
  developerComment?: PlayReviewDeveloperComment;
}

export interface PlayReviewUserComment {
  text?: string;
  originalText?: string;
  lastModified?: PlayTimestamp;
  starRating?: number;
  reviewerLanguage?: string;
  device?: string;
  androidOsVersion?: number;
  appVersionCode?: string;
  appVersionName?: string;
  thumbsUpCount?: number;
  thumbsDownCount?: number;
  deviceMetadata?: PlayReviewDeviceMetadata;
}

export interface PlayReviewDeveloperComment {
  text?: string;
  lastModified?: PlayTimestamp;
}

export interface PlayTimestamp {
  seconds?: string;
  nanos?: number;
}

export interface PlayReviewDeviceMetadata {
  productName?: string;
  manufacturer?: string;
  deviceClass?: string;
  screenWidthPx?: number;
  screenHeightPx?: number;
  nativePlatform?: string;
  screenDensityDpi?: number;
  glEsVersion?: number;
  cpuModel?: string;
  cpuMake?: string;
  ramMb?: number;
}

export interface PlayReviewPage {
  reviews: PlayReview[];
  nextPageToken?: string;
}
