import type { DateRange } from "../utils/dateRanges.js";
import { dateRangeDays, PLAY_VITALS_TIME_ZONE } from "../utils/dateRanges.js";
import type { PlayErrorIssue } from "../schemas/playApiTypes.js";
import { issueSummarySchema, type IssueState, type IssueSummary } from "../schemas/cliOutputs.js";

export interface RankIssuesInput {
  currentIssues: PlayErrorIssue[];
  previousIssues?: PlayErrorIssue[];
  userPerceivedIssues?: PlayErrorIssue[];
  dateRange: DateRange;
  stateFilter?: IssueState | "all";
  limit: number;
}

interface RankingCandidate {
  issue: PlayErrorIssue;
  issueId: string;
  state: IssueState;
  affectedUsers: number;
  eventCount: number;
  affectedUsersPercent: number | null;
  previousAffectedUsers: number;
  previousEventCount: number;
  userPerceivedAffectedUsers: number;
  userPerceivedEventCount: number;
  recencyDays: number | null;
}

export function rankIssues(input: RankIssuesInput): IssueSummary[] {
  const previousById = issueMapById(input.previousIssues ?? []);
  const userPerceivedById = issueMapById(input.userPerceivedIssues ?? []);
  const candidates = dedupeIssues(input.currentIssues)
    .map((issue) => toCandidate(issue, previousById, userPerceivedById, input.dateRange))
    .filter((candidate) => input.stateFilter === undefined || input.stateFilter === "all" || candidate.state === input.stateFilter);
  const factorMaxima = {
    affectedUsers: maxBy(candidates, (candidate) => candidate.affectedUsers),
    eventCount: maxBy(candidates, (candidate) => candidate.eventCount),
    growth: maxBy(candidates, (candidate) =>
      Math.max(candidate.affectedUsers - candidate.previousAffectedUsers, candidate.eventCount - candidate.previousEventCount, 0)
    ),
    userPerceived: maxBy(candidates, (candidate) =>
      Math.max(candidate.userPerceivedAffectedUsers, candidate.userPerceivedEventCount)
    )
  };

  return candidates
    .map((candidate) => toIssueSummary(candidate, input.dateRange, factorMaxima))
    .sort(compareIssueSummaries)
    .slice(0, input.limit)
    .map((issue, index) => issueSummarySchema.parse({ ...issue, rank: { ...issue.rank, position: index + 1 } }));
}

export function issueIdFromName(name: string): string {
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

export function issueTypeApiValue(type: "crash" | "anr"): "CRASH" | "ANR" {
  return type === "anr" ? "ANR" : "CRASH";
}

function toCandidate(
  issue: PlayErrorIssue,
  previousById: Map<string, PlayErrorIssue>,
  userPerceivedById: Map<string, PlayErrorIssue>,
  dateRange: DateRange
): RankingCandidate {
  const issueId = issueIdFromName(issue.name);
  const previous = previousById.get(issueId);
  const userPerceived = userPerceivedById.get(issueId);

  return {
    issue,
    issueId,
    state: inferIssueState(issue, dateRange),
    affectedUsers: integerMetric(issue.distinctUsers),
    eventCount: integerMetric(issue.errorReportCount),
    affectedUsersPercent: decimalMetric(issue.distinctUsersPercent),
    previousAffectedUsers: integerMetric(previous?.distinctUsers),
    previousEventCount: integerMetric(previous?.errorReportCount),
    userPerceivedAffectedUsers: integerMetric(userPerceived?.distinctUsers),
    userPerceivedEventCount: integerMetric(userPerceived?.errorReportCount),
    recencyDays: recencyDays(issue.lastErrorReportTime, dateRange.endDateExclusive)
  };
}

function toIssueSummary(
  candidate: RankingCandidate,
  dateRange: DateRange,
  factorMaxima: {
    affectedUsers: number;
    eventCount: number;
    growth: number;
    userPerceived: number;
  }
): IssueSummary {
  const affectedUsersDelta = candidate.affectedUsers - candidate.previousAffectedUsers;
  const eventCountDelta = candidate.eventCount - candidate.previousEventCount;
  const growthMagnitude = Math.max(affectedUsersDelta, eventCountDelta, 0);
  const userPerceivedMagnitude = Math.max(candidate.userPerceivedAffectedUsers, candidate.userPerceivedEventCount);
  const factors = {
    affectedUsers: normalizedLogScore(candidate.affectedUsers, factorMaxima.affectedUsers),
    eventCount: normalizedLogScore(candidate.eventCount, factorMaxima.eventCount),
    growth: normalizedLogScore(growthMagnitude, factorMaxima.growth),
    recency: recencyScore(candidate.recencyDays, dateRange),
    userPerceived: userPerceivedMagnitude > 0 ? Math.max(0.5, normalizedLogScore(userPerceivedMagnitude, factorMaxima.userPerceived)) : 0
  };
  const score =
    factors.affectedUsers * 0.35 +
    factors.eventCount * 0.25 +
    factors.growth * 0.2 +
    factors.recency * 0.1 +
    factors.userPerceived * 0.1;

  return {
    issueId: candidate.issueId,
    name: candidate.issue.name,
    type: candidate.issue.type ?? "unknown",
    state: candidate.state,
    cause: candidate.issue.cause,
    location: candidate.issue.location,
    firstAppVersion: candidate.issue.firstAppVersion?.versionCode,
    lastAppVersion: candidate.issue.lastAppVersion?.versionCode,
    firstOsVersion: candidate.issue.firstOsVersion?.apiLevel,
    lastOsVersion: candidate.issue.lastOsVersion?.apiLevel,
    lastErrorReportTime: candidate.issue.lastErrorReportTime,
    sampleErrorReports: candidate.issue.sampleErrorReports ?? [],
    issueUri: candidate.issue.issueUri,
    current: {
      affectedUsers: candidate.affectedUsers,
      eventCount: candidate.eventCount,
      affectedUsersPercent: candidate.affectedUsersPercent
    },
    previous: {
      affectedUsers: candidate.previousAffectedUsers,
      eventCount: candidate.previousEventCount
    },
    growth: {
      affectedUsersDelta,
      eventCountDelta,
      affectedUsersRatio: growthRatio(candidate.affectedUsers, candidate.previousAffectedUsers),
      eventCountRatio: growthRatio(candidate.eventCount, candidate.previousEventCount)
    },
    impact: {
      userPerceived: userPerceivedMagnitude > 0,
      userPerceivedAffectedUsers: candidate.userPerceivedAffectedUsers,
      userPerceivedEventCount: candidate.userPerceivedEventCount,
      recencyDays: candidate.recencyDays
    },
    rank: {
      position: 0,
      score: roundScore(score),
      factors
    }
  };
}

function issueMapById(issues: PlayErrorIssue[]): Map<string, PlayErrorIssue> {
  return new Map(dedupeIssues(issues).map((issue) => [issueIdFromName(issue.name), issue]));
}

function dedupeIssues(issues: PlayErrorIssue[]): PlayErrorIssue[] {
  return [...new Map(issues.map((issue) => [issueIdFromName(issue.name), issue])).values()];
}

function inferIssueState(issue: PlayErrorIssue, dateRange: DateRange): IssueState {
  const lastReportDate = issue.lastErrorReportTime
    ? dateInTimeZone(issue.lastErrorReportTime, PLAY_VITALS_TIME_ZONE)
    : null;

  if (!lastReportDate) {
    return "unknown";
  }

  return lastReportDate >= dateRange.startDate && lastReportDate < dateRange.endDateExclusive ? "open" : "unknown";
}

function dateInTimeZone(isoTime: string, timeZone: string): string | null {
  const date = new Date(isoTime);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return year && month && day ? `${year}-${month}-${day}` : null;
}

function recencyDays(lastReportTime: string | undefined, endDateExclusive: string): number | null {
  if (!lastReportTime) {
    return null;
  }

  const lastReportMs = Date.parse(lastReportTime);

  if (!Number.isFinite(lastReportMs)) {
    return null;
  }

  const referenceMs = Date.parse(`${endDateExclusive}T00:00:00.000Z`);

  return Math.max(0, (referenceMs - lastReportMs) / 86_400_000);
}

function recencyScore(value: number | null, dateRange: DateRange): number {
  if (value === null) {
    return 0;
  }

  return Math.max(0, 1 - value / Math.max(dateRangeDays(dateRange.startDate, dateRange.endDateExclusive), 1));
}

function growthRatio(current: number, previous: number): number | null {
  if (previous === 0) {
    return current > 0 ? null : 0;
  }

  return current / previous;
}

function integerMetric(value: string | undefined): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function decimalMetric(value: string | undefined): number | null {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedLogScore(value: number, max: number): number {
  if (max <= 0 || value <= 0) {
    return 0;
  }

  return Math.log1p(value) / Math.log1p(max);
}

function maxBy<TValue>(values: TValue[], valueForItem: (value: TValue) => number): number {
  return values.reduce((max, value) => Math.max(max, valueForItem(value)), 0);
}

function compareIssueSummaries(left: IssueSummary, right: IssueSummary): number {
  return (
    right.rank.score - left.rank.score ||
    right.current.affectedUsers - left.current.affectedUsers ||
    right.current.eventCount - left.current.eventCount ||
    left.issueId.localeCompare(right.issueId)
  );
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
