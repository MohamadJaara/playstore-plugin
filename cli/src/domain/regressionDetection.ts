import type { PlayErrorIssue } from "../schemas/playApiTypes.js";
import {
  releaseMetricRegressionSchema,
  regressionIssueChangeSchema,
  type RegressionIssueChange,
  type RegressionIssueSnapshot,
  type RegressionSeverity,
  type ReleaseHealthMetricGroup,
  type ReleaseMetricRegression
} from "../schemas/cliOutputs.js";
import { issueIdFromName } from "./issueRanking.js";

export interface ReleaseRegressionDetectionInput {
  currentMetricGroups: ReleaseHealthMetricGroup[];
  previousMetricGroups: ReleaseHealthMetricGroup[];
  currentIssues: PlayErrorIssue[];
  previousIssues: PlayErrorIssue[];
  historicalIssues?: PlayErrorIssue[];
  issueSearchCompleteness?: {
    current: boolean;
    previous: boolean;
    historical: boolean;
  };
  currentUserPerceivedIssues?: PlayErrorIssue[];
  previousUserPerceivedIssues?: PlayErrorIssue[];
  historicalUserPerceivedIssues?: PlayErrorIssue[];
  limit: number;
}

export interface ReleaseRegressionDetectionResult {
  metrics: ReleaseMetricRegression[];
  issues: {
    newIssues: RegressionIssueChange[];
    resurfacedIssues: RegressionIssueChange[];
    worsenedIssues: RegressionIssueChange[];
    fixedIssues: RegressionIssueChange[];
    unchangedCount: number;
    lowVolumeMonitorCount: number;
  };
}

interface IssueMaps {
  currentById: Map<string, PlayErrorIssue>;
  previousById: Map<string, PlayErrorIssue>;
  historicalById: Map<string, PlayErrorIssue>;
  currentComplete: boolean;
  previousComplete: boolean;
  historicalComplete: boolean;
  currentUserPerceivedById: Map<string, PlayErrorIssue>;
  previousUserPerceivedById: Map<string, PlayErrorIssue>;
  historicalUserPerceivedById: Map<string, PlayErrorIssue>;
}

const SEVERITY_ORDER: Record<RegressionSeverity, number> = {
  monitor: 0,
  investigate: 1,
  "high-risk": 2
};

const LOW_VOLUME_AFFECTED_USERS = 10;
const LOW_VOLUME_EVENTS = 20;
const INVESTIGATE_AFFECTED_USERS_DELTA = 10;
const INVESTIGATE_EVENTS_DELTA = 20;
const HIGH_RISK_AFFECTED_USERS_DELTA = 50;
const HIGH_RISK_EVENTS_DELTA = 100;
const INVESTIGATE_USER_PERCEIVED_DELTA = 5;
const HIGH_RISK_USER_PERCEIVED_DELTA = 25;
const WORSENED_RATIO = 1.5;
const HIGH_RISK_RATIO = 3;

const METRIC_LOW_VOLUME_USER_DAYS = 50;
const INVESTIGATE_RATE_DELTA = 0.003;
const HIGH_RISK_RATE_DELTA = 0.01;
const INVESTIGATE_USER_PERCEIVED_RATE_DELTA = 0.001;
const HIGH_RISK_USER_PERCEIVED_RATE_DELTA = 0.005;

export function detectReleaseRegressions(input: ReleaseRegressionDetectionInput): ReleaseRegressionDetectionResult {
  const metrics = detectMetricRegressions(input.currentMetricGroups, input.previousMetricGroups);
  const issueDetection = detectIssueRegressions(input);

  return {
    metrics,
    issues: issueDetection
  };
}

function detectMetricRegressions(
  currentMetricGroups: ReleaseHealthMetricGroup[],
  previousMetricGroups: ReleaseHealthMetricGroup[]
): ReleaseMetricRegression[] {
  const previousBySignal = new Map(previousMetricGroups.map((group) => [group.signal, group]));

  return currentMetricGroups.map((currentGroup) => {
    const previousGroup = previousBySignal.get(currentGroup.signal);
    const current = metricSnapshot(currentGroup);
    const previous = previousGroup ? metricSnapshot(previousGroup) : emptyMetricSnapshot();
    const deltas = {
      rate: metricDelta(current.rate, previous.rate),
      userPerceivedRate: metricDelta(current.userPerceivedRate, previous.userPerceivedRate),
      distinctUserDays: metricDelta(current.distinctUserDays, previous.distinctUserDays)
    };
    const reasons = metricReasons(currentGroup.signal, deltas, current, previous);
    const severity = metricSeverity(deltas, current);

    return releaseMetricRegressionSchema.parse({
      signal: currentGroup.signal,
      severity,
      current,
      previous,
      deltas,
      reasons,
      nextActions: metricNextActions(currentGroup.signal, severity)
    });
  });
}

function detectIssueRegressions(input: ReleaseRegressionDetectionInput): ReleaseRegressionDetectionResult["issues"] {
  const maps: IssueMaps = {
    currentById: issueMapById(input.currentIssues),
    previousById: issueMapById(input.previousIssues),
    historicalById: issueMapById(input.historicalIssues ?? []),
    currentComplete: input.issueSearchCompleteness?.current ?? true,
    previousComplete: input.issueSearchCompleteness?.previous ?? true,
    historicalComplete: input.issueSearchCompleteness?.historical ?? true,
    currentUserPerceivedById: issueMapById(input.currentUserPerceivedIssues ?? []),
    previousUserPerceivedById: issueMapById(input.previousUserPerceivedIssues ?? []),
    historicalUserPerceivedById: issueMapById(input.historicalUserPerceivedIssues ?? [])
  };
  const newIssues: RegressionIssueChange[] = [];
  const resurfacedIssues: RegressionIssueChange[] = [];
  const worsenedIssues: RegressionIssueChange[] = [];
  const fixedIssues: RegressionIssueChange[] = [];
  let unchangedCount = 0;
  let lowVolumeMonitorCount = 0;

  for (const issueId of unionKeys(maps.currentById, maps.previousById)) {
    const change = issueChange(issueId, maps);

    if (!change) {
      unchangedCount += 1;
      continue;
    }

    if (change.severity === "monitor" && change.classification !== "fixed" && isLowVolume(change.current)) {
      lowVolumeMonitorCount += 1;
    }

    if (change.classification === "new") {
      newIssues.push(change);
    } else if (change.classification === "resurfaced") {
      resurfacedIssues.push(change);
    } else if (change.classification === "worsened") {
      worsenedIssues.push(change);
    } else {
      fixedIssues.push(change);
    }
  }

  return {
    newIssues: sortIssueChanges(newIssues).slice(0, input.limit),
    resurfacedIssues: sortIssueChanges(resurfacedIssues).slice(0, input.limit),
    worsenedIssues: sortIssueChanges(worsenedIssues).slice(0, input.limit),
    fixedIssues: sortFixedIssueChanges(fixedIssues).slice(0, input.limit),
    unchangedCount,
    lowVolumeMonitorCount
  };
}

function issueChange(issueId: string, maps: IssueMaps): RegressionIssueChange | null {
  const currentIssue = maps.currentById.get(issueId);
  const previousIssue = maps.previousById.get(issueId);
  const historicalIssue = maps.historicalById.get(issueId);
  const current = issueSnapshot(currentIssue, maps.currentUserPerceivedById.get(issueId));
  const previous = issueSnapshot(previousIssue, maps.previousUserPerceivedById.get(issueId));
  const historical = issueSnapshot(historicalIssue, maps.historicalUserPerceivedById.get(issueId));
  const currentActive = hasIssueActivity(current);
  const previousActive = hasIssueActivity(previous);
  const historicalActive = hasIssueActivity(historical);
  const deltas = {
    affectedUsersDelta: current.affectedUsers - previous.affectedUsers,
    eventCountDelta: current.eventCount - previous.eventCount,
    affectedUsersRatio: growthRatio(current.affectedUsers, previous.affectedUsers),
    eventCountRatio: growthRatio(current.eventCount, previous.eventCount)
  };
  const classification = classifyIssueChange(current, previous, historicalActive, deltas);

  if (!classification || (!currentActive && !previousActive)) {
    return null;
  }

  if (classification === "fixed" && !maps.currentComplete && !currentIssue) {
    return null;
  }

  if ((classification === "new" || classification === "resurfaced") && !maps.previousComplete && !previousIssue) {
    return null;
  }

  if (classification === "new" && !maps.historicalComplete && !historicalIssue) {
    return null;
  }

  const canonicalIssue = currentIssue ?? previousIssue ?? historicalIssue;

  if (!canonicalIssue) {
    return null;
  }

  const severity = issueSeverity(classification, current, previous, deltas);
  const reasons = issueReasons(classification, current, previous, historical, deltas);

  return regressionIssueChangeSchema.parse({
    issueId,
    name: canonicalIssue.name,
    type: canonicalIssue.type ?? "unknown",
    classification,
    severity,
    cause: canonicalIssue.cause,
    location: canonicalIssue.location,
    firstAppVersion: canonicalIssue.firstAppVersion?.versionCode,
    lastAppVersion: canonicalIssue.lastAppVersion?.versionCode,
    lastErrorReportTime: currentIssue?.lastErrorReportTime ?? previousIssue?.lastErrorReportTime ?? historicalIssue?.lastErrorReportTime,
    sampleErrorReports: canonicalIssue.sampleErrorReports ?? [],
    issueUri: canonicalIssue.issueUri,
    current,
    previous,
    historical: historicalActive ? historical : undefined,
    deltas,
    reasons,
    nextActions: issueNextActions(classification, severity)
  });
}

function classifyIssueChange(
  current: RegressionIssueSnapshot,
  previous: RegressionIssueSnapshot,
  historicalActive: boolean,
  deltas: RegressionIssueChange["deltas"]
): RegressionIssueChange["classification"] | null {
  const currentActive = hasIssueActivity(current);
  const previousActive = hasIssueActivity(previous);

  if (currentActive && !previousActive) {
    return historicalActive ? "resurfaced" : "new";
  }

  if (!currentActive && previousActive) {
    return "fixed";
  }

  if (currentActive && previousActive && isMeaningfullyWorse(current, previous, deltas)) {
    return "worsened";
  }

  return null;
}

function isMeaningfullyWorse(
  current: RegressionIssueSnapshot,
  previous: RegressionIssueSnapshot,
  deltas: RegressionIssueChange["deltas"]
): boolean {
  const affectedWorse =
    deltas.affectedUsersDelta >= 3 &&
    current.affectedUsers >= LOW_VOLUME_AFFECTED_USERS &&
    (deltas.affectedUsersRatio ?? 0) >= WORSENED_RATIO;
  const eventsWorse =
    deltas.eventCountDelta >= 5 &&
    current.eventCount >= LOW_VOLUME_EVENTS &&
    (deltas.eventCountRatio ?? 0) >= WORSENED_RATIO;
  const userPerceivedWorse =
    current.userPerceivedAffectedUsers - previous.userPerceivedAffectedUsers >= 3 ||
    current.userPerceivedEventCount - previous.userPerceivedEventCount >= 5;

  return affectedWorse || eventsWorse || userPerceivedWorse;
}

function issueSeverity(
  classification: RegressionIssueChange["classification"],
  current: RegressionIssueSnapshot,
  previous: RegressionIssueSnapshot,
  deltas: RegressionIssueChange["deltas"]
): RegressionSeverity {
  if (classification === "fixed") {
    return "monitor";
  }

  if (isLowVolume(current)) {
    return "monitor";
  }

  const userPerceivedAffectedDelta = current.userPerceivedAffectedUsers - previous.userPerceivedAffectedUsers;
  const userPerceivedEventDelta = current.userPerceivedEventCount - previous.userPerceivedEventCount;
  const largestRatio = Math.max(deltas.affectedUsersRatio ?? 0, deltas.eventCountRatio ?? 0);

  if (
    deltas.affectedUsersDelta >= HIGH_RISK_AFFECTED_USERS_DELTA ||
    deltas.eventCountDelta >= HIGH_RISK_EVENTS_DELTA ||
    userPerceivedAffectedDelta >= HIGH_RISK_USER_PERCEIVED_DELTA ||
    userPerceivedEventDelta >= HIGH_RISK_USER_PERCEIVED_DELTA ||
    (largestRatio >= HIGH_RISK_RATIO && current.affectedUsers >= INVESTIGATE_AFFECTED_USERS_DELTA)
  ) {
    return "high-risk";
  }

  if (
    deltas.affectedUsersDelta >= INVESTIGATE_AFFECTED_USERS_DELTA ||
    deltas.eventCountDelta >= INVESTIGATE_EVENTS_DELTA ||
    userPerceivedAffectedDelta >= INVESTIGATE_USER_PERCEIVED_DELTA ||
    userPerceivedEventDelta >= INVESTIGATE_USER_PERCEIVED_DELTA ||
    largestRatio >= WORSENED_RATIO
  ) {
    return "investigate";
  }

  return "monitor";
}

function metricSeverity(
  deltas: ReleaseMetricRegression["deltas"],
  current: ReleaseMetricRegression["current"]
): RegressionSeverity {
  const lowVolume = (current.distinctUserDays ?? 0) < METRIC_LOW_VOLUME_USER_DAYS;

  if (lowVolume) {
    return "monitor";
  }

  if (
    exceedsDelta(deltas.userPerceivedRate, HIGH_RISK_USER_PERCEIVED_RATE_DELTA) ||
    exceedsDelta(deltas.rate, HIGH_RISK_RATE_DELTA)
  ) {
    return "high-risk";
  }

  if (
    exceedsDelta(deltas.userPerceivedRate, INVESTIGATE_USER_PERCEIVED_RATE_DELTA) ||
    exceedsDelta(deltas.rate, INVESTIGATE_RATE_DELTA)
  ) {
    return "investigate";
  }

  return "monitor";
}

function metricSnapshot(group: ReleaseHealthMetricGroup): ReleaseMetricRegression["current"] {
  return {
    rate: group.summary.rate.value,
    userPerceivedRate: group.summary.userPerceivedRate.value,
    distinctUserDays: group.summary.distinctUsers.userDays,
    dataPoints: Math.max(group.summary.rate.dataPoints, group.summary.userPerceivedRate.dataPoints)
  };
}

function emptyMetricSnapshot(): ReleaseMetricRegression["current"] {
  return {
    rate: null,
    userPerceivedRate: null,
    distinctUserDays: null,
    dataPoints: 0
  };
}

function metricDelta(current: number | null, previous: number | null): ReleaseMetricRegression["deltas"]["rate"] {
  const absoluteDelta = typeof current === "number" && typeof previous === "number" ? roundMetric(current - previous) : null;
  const relativeRatio = typeof current === "number" && typeof previous === "number" ? growthRatio(current, previous) : null;

  return {
    current,
    previous,
    absoluteDelta,
    relativeRatio: relativeRatio === null ? null : roundMetric(relativeRatio),
    worsened: absoluteDelta !== null && absoluteDelta > 0
  };
}

function issueSnapshot(issue: PlayErrorIssue | undefined, userPerceivedIssue: PlayErrorIssue | undefined): RegressionIssueSnapshot {
  return {
    affectedUsers: integerMetric(issue?.distinctUsers),
    eventCount: integerMetric(issue?.errorReportCount),
    affectedUsersPercent: decimalMetric(issue?.distinctUsersPercent),
    userPerceivedAffectedUsers: integerMetric(userPerceivedIssue?.distinctUsers),
    userPerceivedEventCount: integerMetric(userPerceivedIssue?.errorReportCount),
    lastErrorReportTime: issue?.lastErrorReportTime
  };
}

function issueMapById(issues: PlayErrorIssue[]): Map<string, PlayErrorIssue> {
  return new Map(dedupeIssues(issues).map((issue) => [issueIdFromName(issue.name), issue]));
}

function dedupeIssues(issues: PlayErrorIssue[]): PlayErrorIssue[] {
  return [...new Map(issues.map((issue) => [issueIdFromName(issue.name), issue])).values()];
}

function unionKeys<TKey, TValue>(...maps: Array<Map<TKey, TValue>>): TKey[] {
  return [...new Set(maps.flatMap((map) => [...map.keys()]))];
}

function sortIssueChanges(changes: RegressionIssueChange[]): RegressionIssueChange[] {
  return [...changes].sort(
    (left, right) =>
      SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
      right.deltas.affectedUsersDelta - left.deltas.affectedUsersDelta ||
      right.deltas.eventCountDelta - left.deltas.eventCountDelta ||
      right.current.affectedUsers - left.current.affectedUsers ||
      right.previous.affectedUsers - left.previous.affectedUsers ||
      left.issueId.localeCompare(right.issueId)
  );
}

function sortFixedIssueChanges(changes: RegressionIssueChange[]): RegressionIssueChange[] {
  return [...changes].sort(
    (left, right) =>
      right.previous.userPerceivedAffectedUsers - left.previous.userPerceivedAffectedUsers ||
      right.previous.userPerceivedEventCount - left.previous.userPerceivedEventCount ||
      right.previous.affectedUsers - left.previous.affectedUsers ||
      right.previous.eventCount - left.previous.eventCount ||
      Math.abs(right.deltas.affectedUsersDelta) - Math.abs(left.deltas.affectedUsersDelta) ||
      Math.abs(right.deltas.eventCountDelta) - Math.abs(left.deltas.eventCountDelta) ||
      left.issueId.localeCompare(right.issueId)
  );
}

function hasIssueActivity(snapshot: RegressionIssueSnapshot): boolean {
  return snapshot.affectedUsers > 0 || snapshot.eventCount > 0;
}

function isLowVolume(snapshot: RegressionIssueSnapshot): boolean {
  return (
    snapshot.affectedUsers < LOW_VOLUME_AFFECTED_USERS &&
    snapshot.eventCount < LOW_VOLUME_EVENTS &&
    snapshot.userPerceivedAffectedUsers === 0 &&
    snapshot.userPerceivedEventCount === 0
  );
}

function exceedsDelta(delta: ReleaseMetricRegression["deltas"]["rate"], threshold: number): boolean {
  return delta.absoluteDelta !== null && delta.absoluteDelta >= threshold;
}

function metricReasons(
  signal: ReleaseHealthMetricGroup["signal"],
  deltas: ReleaseMetricRegression["deltas"],
  current: ReleaseMetricRegression["current"],
  previous: ReleaseMetricRegression["previous"]
): string[] {
  const reasons: string[] = [];

  if (deltas.userPerceivedRate.worsened) {
    reasons.push(
      `User-perceived ${signal} rate increased by ${formatPercentagePointDelta(
        deltas.userPerceivedRate.absoluteDelta
      )}${formatRatioSuffix(deltas.userPerceivedRate.relativeRatio)}.`
    );
  }

  if (deltas.rate.worsened) {
    reasons.push(
      `${titleCase(signal)} rate increased by ${formatPercentagePointDelta(deltas.rate.absoluteDelta)}${formatRatioSuffix(
        deltas.rate.relativeRatio
      )}.`
    );
  }

  if ((current.distinctUserDays ?? 0) < METRIC_LOW_VOLUME_USER_DAYS) {
    reasons.push(
      `Only ${formatNumber(current.distinctUserDays)} current distinct user-days were returned, so metric deltas are noise-prone.`
    );
  }

  if (previous.dataPoints === 0) {
    reasons.push("Previous release metric rows were unavailable for this signal.");
  }

  return reasons;
}

function metricNextActions(signal: ReleaseHealthMetricGroup["signal"], severity: RegressionSeverity): string[] {
  if (severity === "high-risk") {
    return [
      `Inspect ${signal} rate slices by API level and device model before rollout expansion.`,
      "Pull representative issue reports for the highest-severity issue regressions."
    ];
  }

  if (severity === "investigate") {
    return [`Check ${signal} metric slices for concentrated device, Android version, or country regressions.`];
  }

  return [`Continue monitoring ${signal} rates until the next release-health window has enough volume.`];
}

function issueReasons(
  classification: RegressionIssueChange["classification"],
  current: RegressionIssueSnapshot,
  previous: RegressionIssueSnapshot,
  historical: RegressionIssueSnapshot,
  deltas: RegressionIssueChange["deltas"]
): string[] {
  const reasons: string[] = [];

  if (classification === "new") {
    reasons.push(`Observed in the current release with ${formatNumber(current.affectedUsers)} affected users and was absent from the previous release.`);
  } else if (classification === "resurfaced") {
    reasons.push(
      `Absent from the previous release window but seen in the prior comparison window with ${formatNumber(
        historical.affectedUsers
      )} affected users.`
    );
  } else if (classification === "worsened") {
    reasons.push(
      `Affected users changed by ${formatSignedNumber(deltas.affectedUsersDelta)}${formatRatioSuffix(
        deltas.affectedUsersRatio
      )}; events changed by ${formatSignedNumber(deltas.eventCountDelta)}${formatRatioSuffix(deltas.eventCountRatio)}.`
    );
  } else {
    reasons.push(`No current release occurrences were returned after ${formatNumber(previous.affectedUsers)} affected users in the previous release.`);
  }

  const userPerceivedAffectedDelta = current.userPerceivedAffectedUsers - previous.userPerceivedAffectedUsers;
  const userPerceivedEventDelta = current.userPerceivedEventCount - previous.userPerceivedEventCount;

  if (current.userPerceivedAffectedUsers > 0 || current.userPerceivedEventCount > 0) {
    reasons.push(
      `User-perceived impact is present: ${formatNumber(current.userPerceivedAffectedUsers)} users and ${formatNumber(
        current.userPerceivedEventCount
      )} events.`
    );
  }

  if (userPerceivedAffectedDelta > 0 || userPerceivedEventDelta > 0) {
    reasons.push(
      `User-perceived deltas are ${formatSignedNumber(userPerceivedAffectedDelta)} users and ${formatSignedNumber(
        userPerceivedEventDelta
      )} events.`
    );
  }

  if (classification !== "fixed" && isLowVolume(current)) {
    reasons.push("Current issue volume is low, so the change is labeled monitor until more reports arrive.");
  }

  return reasons;
}

function issueNextActions(
  classification: RegressionIssueChange["classification"],
  severity: RegressionSeverity
): string[] {
  if (classification === "fixed") {
    return ["Keep this issue on the watch list for one more comparison window to confirm it stays quiet."];
  }

  const actions = ["Fetch representative reports for this issue and compare top frames against recent release changes."];

  if (classification === "resurfaced") {
    actions.push("Check the previous fix or mitigation for recurrence conditions.");
  }

  if (severity === "high-risk") {
    actions.push("Treat this as a rollout-risk signal until an owner has confirmed scope and mitigation.");
  } else if (severity === "investigate") {
    actions.push("Assign an owner to validate impact and affected surfaces.");
  } else {
    actions.push("Keep monitoring and escalate if affected users or user-perceived reports keep increasing.");
  }

  return actions;
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

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function formatPercentagePointDelta(value: number | null): string {
  return value === null ? "unknown" : `${formatSignedNumber(Number((value * 100).toFixed(3)))}pp`;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatNumber(value: number | null): string {
  return value === null ? "missing" : new Intl.NumberFormat("en-US").format(value);
}

function formatRatioSuffix(value: number | null): string {
  return value === null ? "" : ` (${Number(value.toFixed(2))}x)`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
