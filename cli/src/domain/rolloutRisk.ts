import type {
  AnomaliesListOutput,
  IssueSummary,
  ReleaseHealthMetricGroup,
  RolloutRiskRecommendation,
  RolloutRiskRecommendationCategory,
  RolloutRiskReportOutput,
  ReviewsRecentOutput
} from "../schemas/cliOutputs.js";

export interface RolloutRiskAssessmentInput {
  facts: RolloutRiskReportOutput["facts"];
}

interface ScoreContribution {
  points: number;
  reason: string;
  haltSignal?: boolean;
}

const READ_ONLY_NOTICE =
  "This plugin is read-only. It can recommend a manual rollout decision, but it cannot pause, halt, promote, edit, or otherwise mutate a Play rollout.";

export function assessRolloutRisk(input: RolloutRiskAssessmentInput): RolloutRiskRecommendation {
  const contributions = [
    ...scoreHealthFacts(input.facts.health.metricGroups),
    ...scoreIssueFacts(input.facts.topIssues.issues),
    ...scoreAnomalyFacts(input.facts.anomalies),
    ...scoreReviewFacts(input.facts.reviews)
  ];
  const score = Math.min(
    100,
    contributions.reduce((sum, contribution) => sum + contribution.points, 0)
  );
  const category = recommendationCategory(score, contributions);
  const reasons = contributions
    .filter((contribution) => contribution.points > 0 || contribution.haltSignal)
    .map((contribution) => contribution.reason);

  return {
    category,
    score,
    maxScore: 100,
    basis: "inferred recommendation from measured Play Console facts",
    reasons: reasons.length > 0 ? dedupe(reasons) : ["No elevated rollout-risk signals were found in the measured facts."],
    nextActions: nextActionsForCategory(category, input.facts),
    readOnlyNotice: READ_ONLY_NOTICE
  };
}

function scoreHealthFacts(metricGroups: ReleaseHealthMetricGroup[]): ScoreContribution[] {
  return metricGroups.map((group) => {
    const rate = group.summary.rate.value;
    const userPerceivedRate = group.summary.userPerceivedRate.value;
    const userDays = group.summary.distinctUsers.userDays ?? 0;
    const points = Math.min(
      40,
      healthRatePoints(rate, 0.01, 0.03) +
        healthRatePoints(userPerceivedRate, 0.003, 0.01) +
        (userDays > 0 && userDays < 50 && (positiveNumber(rate) || positiveNumber(userPerceivedRate)) ? 5 : 0)
    );

    if (points === 0) {
      return {
        points: 0,
        reason: `${titleCase(group.signal)} health rates did not add rollout-risk points.`
      };
    }

    return {
      points,
      haltSignal: exceeds(userPerceivedRate, 0.01) || exceeds(rate, 0.03),
      reason: `${titleCase(group.signal)} health contributed ${points} risk point(s): rate=${formatRatio(rate)}, user-perceived=${formatRatio(userPerceivedRate)}, user-days=${formatNumber(userDays)}.`
    };
  });
}

function healthRatePoints(value: number | null, investigateThreshold: number, haltThreshold: number): number {
  if (!positiveNumber(value)) {
    return 0;
  }

  if (value >= haltThreshold) {
    return 25;
  }

  if (value >= investigateThreshold) {
    return 15;
  }

  return 5;
}

function scoreIssueFacts(issues: IssueSummary[]): ScoreContribution[] {
  const issueContributions = issues.slice(0, 3).map(scoreIssue);
  const points = Math.min(
    35,
    issueContributions.reduce((sum, contribution) => sum + contribution.points, 0)
  );
  const haltSignal = issueContributions.some((contribution) => contribution.haltSignal);
  const topIssue = issues[0];

  if (!topIssue || points === 0) {
    return [
      {
        points: 0,
        reason: "No top crash/ANR issues added rollout-risk points."
      }
    ];
  }

  return [
    {
      points,
      haltSignal,
      reason: `Top crash/ANR issues contributed ${points} risk point(s); highest-ranked issue ${topIssue.issueId} affected ${formatNumber(topIssue.current.affectedUsers)} user(s), ${formatNumber(topIssue.current.eventCount)} event(s), and ${formatNumber(topIssue.impact.userPerceivedAffectedUsers)} user-perceived user(s).`
    }
  ];
}

function scoreIssue(issue: IssueSummary): ScoreContribution {
  const userPerceivedUsers = issue.impact.userPerceivedAffectedUsers;
  const affectedUsers = issue.current.affectedUsers;
  const eventCount = issue.current.eventCount;
  let points = 0;

  if (affectedUsers >= 100 || userPerceivedUsers >= 50 || eventCount >= 250) {
    points += 30;
  } else if (affectedUsers >= 25 || userPerceivedUsers >= 10 || eventCount >= 75) {
    points += 20;
  } else if (affectedUsers > 0 || eventCount > 0) {
    points += 8;
  }

  if (issue.growth.affectedUsersDelta >= 50 || issue.growth.eventCountDelta >= 100) {
    points += 10;
  } else if (issue.growth.affectedUsersDelta >= 10 || issue.growth.eventCountDelta >= 20) {
    points += 5;
  }

  return {
    points: Math.min(35, points),
    haltSignal: affectedUsers >= 100 || userPerceivedUsers >= 50 || eventCount >= 250,
    reason: issue.issueId
  };
}

function scoreAnomalyFacts(anomalies: AnomaliesListOutput): ScoreContribution[] {
  const crashOrAnrCount = anomalies.anomalies.filter((anomaly) => anomaly.signal === "crash" || anomaly.signal === "anr").length;
  const unknownCount = anomalies.anomalies.length - crashOrAnrCount;
  const points = Math.min(30, crashOrAnrCount * 12 + unknownCount * 6);

  if (points === 0) {
    return [
      {
        points: 0,
        reason: "No active anomalies added rollout-risk points."
      }
    ];
  }

  return [
    {
      points,
      haltSignal: crashOrAnrCount >= 3,
      reason: `${anomalies.anomalies.length} active anomaly signal(s) contributed ${points} risk point(s), including ${crashOrAnrCount} crash/ANR anomaly signal(s).`
    }
  ];
}

function scoreReviewFacts(reviews: ReviewsRecentOutput): ScoreContribution[] {
  const lowRatingSignals = reviews.summary.lowRatingSignalReviewCount;
  const signalReviews = reviews.summary.signalReviewCount;
  const matchedReviews = reviews.summary.matchedReviewCount;
  const signalShare = matchedReviews > 0 ? signalReviews / matchedReviews : 0;
  let points = 0;

  if (lowRatingSignals >= 10) {
    points += 25;
  } else if (lowRatingSignals >= 3) {
    points += 15;
  } else if (lowRatingSignals >= 1) {
    points += 8;
  }

  if (signalShare >= 0.4 && signalReviews >= 3) {
    points += 10;
  }

  if (reviews.summary.averageRating !== null && reviews.summary.averageRating <= 2 && signalReviews > 0) {
    points += 5;
  }

  points = Math.min(25, points);

  if (points === 0) {
    return [
      {
        points: 0,
        reason: "Recent low-rating review signals did not add rollout-risk points."
      }
    ];
  }

  return [
    {
      points,
      reason: `Recent reviews contributed ${points} risk point(s): ${lowRatingSignals} low-rating crash/freeze/ANR signal review(s), ${signalReviews}/${matchedReviews} matched review(s) with stability language.`
    }
  ];
}

function recommendationCategory(
  score: number,
  contributions: ScoreContribution[]
): RolloutRiskRecommendationCategory {
  if (score >= 70 || contributions.some((contribution) => contribution.haltSignal)) {
    return "manually halt rollout outside the plugin";
  }

  if (score >= 30) {
    return "investigate before increasing rollout";
  }

  return "continue monitoring";
}

function nextActionsForCategory(
  category: RolloutRiskRecommendationCategory,
  facts: RolloutRiskReportOutput["facts"]
): string[] {
  const topIssue = facts.topIssues.issues[0];
  const anomalySignals = facts.anomalies.anomalies
    .filter((anomaly) => anomaly.signal === "crash" || anomaly.signal === "anr")
    .map((anomaly) => anomaly.anomalyId);
  const actions: string[] = [];

  if (category === "manually halt rollout outside the plugin") {
    actions.push("Have a release owner manually review and halt rollout in Play Console outside this plugin before expanding exposure.");
  } else if (category === "investigate before increasing rollout") {
    actions.push("Assign an owner to investigate the measured stability signals before increasing rollout exposure.");
  } else {
    actions.push("Continue monitoring the same health, issue, anomaly, and review windows before the next rollout increase.");
  }

  if (topIssue) {
    actions.push(
      `Fetch sample reports for top issue ${topIssue.issueId}: scripts/playstore reports list --package ${facts.health.packageName} --issue-id ${topIssue.issueId} --version-code ${facts.health.versionCodes.join(",")} --start-date ${facts.health.dateRange.startDate} --end-date ${facts.health.dateRange.endDateExclusive} --format markdown`
    );
  }

  if (anomalySignals.length > 0) {
    actions.push(`Review active anomaly context for: ${anomalySignals.slice(0, 5).join(", ")}.`);
  }

  actions.push("Keep rollout actions manual; this report does not and cannot mutate Play Console state.");

  return dedupe(actions);
}

function exceeds(value: number | null, threshold: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= threshold;
}

function positiveNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatRatio(value: number | null): string {
  return value === null ? "missing" : `${(value * 100).toFixed(3)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function dedupe<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}
