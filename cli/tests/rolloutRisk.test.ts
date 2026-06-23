import { describe, expect, it, vi } from "vitest";

import { formatRolloutRiskMarkdown, getRolloutRiskReport } from "../src/commands/report.js";
import type { PlayPublisherClient } from "../src/clients/playPublisherClient.js";
import type { PlayReportingClient } from "../src/clients/playReportingClient.js";
import type { PlaystoreConfig } from "../src/config.js";
import type { PlayAnomaly, PlayErrorIssue, PlayMetricRow, PlayRelease, PlayReview } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("rollout risk report", () => {
  it("combines measured health, issues, anomalies, and reviews into a read-only halt recommendation", async () => {
    const reportingClient = mockRiskReportingClient();
    const publisherClient = mockPublisherClient({
      releases: [
        {
          name: "1.2.3 production",
          versionCodes: ["123"],
          status: "inProgress",
          userFraction: 0.25
        }
      ],
      reviews: [
        review("review-1", {
          text: "Crashes on launch after the update. Email user@example.com.",
          modified: "2026-06-22T12:00:00Z",
          rating: 1,
          versionCode: "123"
        })
      ]
    });

    const output = await getRolloutRiskReport(
      {
        packageName: undefined,
        track: "production",
        versionCodes: ["123"],
        startDate: "2026-06-20",
        endDateExclusive: "2026-06-24",
        issueLimit: 10,
        anomalyLimit: 20,
        reviewLimit: 20,
        reviewFetchLimit: 100,
        maxRating: 2,
        format: "json"
      },
      { config, reportingClient, publisherClient }
    );
    const markdown = formatRolloutRiskMarkdown(output);

    expect(output.recommendation).toMatchObject({
      category: "manually halt rollout outside the plugin",
      maxScore: 100,
      basis: "inferred recommendation from measured Play Console facts"
    });
    expect(output.recommendation.score).toBeGreaterThanOrEqual(70);
    expect(output.recommendation.readOnlyNotice).toContain("cannot pause");
    expect(output.facts.health.metricGroups.find((group) => group.signal === "crash")?.summary.userPerceivedRate.value).toBe(0.012);
    expect(output.facts.topIssues.issues[0]).toMatchObject({
      issueId: "issue-top",
      current: {
        affectedUsers: 120,
        eventCount: 260
      },
      impact: {
        userPerceivedAffectedUsers: 60
      }
    });
    expect(output.facts.anomalies.anomalies.map((entry) => entry.anomalyId)).toEqual(["anomaly-crash"]);
    expect(output.facts.reviews.filters.reviewText).toBe("redacted");
    expect(output.facts.reviews.summary.lowRatingSignalReviewCount).toBe(1);
    expect(JSON.stringify(output)).not.toContain("Crashes on launch");
    expect(JSON.stringify(output)).not.toContain("user@example.com");
    expect(markdown).toContain("## Inferred Recommendation");
    expect(markdown).toContain("## Measured Facts");
    expect(markdown).toContain("Read-only notice");
  });

  it("recommends investigation before rollout increases for medium health risk", async () => {
    const output = await getRolloutRiskReport(
      rolloutRiskInput(),
      {
        config,
        reportingClient: mockRiskReportingClient({
          crashMetrics: { crashRate: 0.015, userPerceivedCrashRate: 0.004, distinctUsers: 800 },
          anrMetrics: { anrRate: 0, userPerceivedAnrRate: 0, distinctUsers: 800 },
          currentIssues: [],
          previousIssues: [],
          userPerceivedIssues: [],
          anomalies: []
        }),
        publisherClient: mockPublisherClient({ releases: [release()], reviews: [] })
      }
    );

    expect(output.recommendation).toMatchObject({
      category: "investigate before increasing rollout",
      maxScore: 100,
      basis: "inferred recommendation from measured Play Console facts"
    });
    expect(output.recommendation.score).toBeGreaterThanOrEqual(30);
    expect(output.recommendation.score).toBeLessThan(70);
    expect(output.recommendation.nextActions[0]).toContain("investigate");
  });

  it("recommends continued monitoring when no elevated rollout-risk signals are measured", async () => {
    const output = await getRolloutRiskReport(
      rolloutRiskInput(),
      {
        config,
        reportingClient: mockRiskReportingClient({
          crashMetrics: { crashRate: 0, userPerceivedCrashRate: 0, distinctUsers: 800 },
          anrMetrics: { anrRate: 0, userPerceivedAnrRate: 0, distinctUsers: 800 },
          currentIssues: [],
          previousIssues: [],
          userPerceivedIssues: [],
          anomalies: []
        }),
        publisherClient: mockPublisherClient({ releases: [release()], reviews: [] })
      }
    );

    expect(output.recommendation).toMatchObject({
      category: "continue monitoring",
      score: 0,
      maxScore: 100,
      basis: "inferred recommendation from measured Play Console facts"
    });
    expect(output.recommendation.reasons).toEqual(["No elevated rollout-risk signals were found in the measured facts."]);
    expect(output.recommendation.nextActions[0]).toContain("Continue monitoring");
  });
});

interface RiskReportingFixtures {
  crashMetrics?: Record<string, number>;
  anrMetrics?: Record<string, number>;
  currentIssues?: PlayErrorIssue[];
  previousIssues?: PlayErrorIssue[];
  userPerceivedIssues?: PlayErrorIssue[];
  anomalies?: PlayAnomaly[];
}

function rolloutRiskInput() {
  return {
    packageName: undefined,
    track: "production",
    versionCodes: ["123"],
    startDate: "2026-06-20",
    endDateExclusive: "2026-06-24",
    issueLimit: 10,
    anomalyLimit: 20,
    reviewLimit: 20,
    reviewFetchLimit: 100,
    maxRating: 2,
    format: "json" as const
  };
}

function mockRiskReportingClient(fixtures: RiskReportingFixtures = {}): PlayReportingClient {
  const crashMetrics = fixtures.crashMetrics ?? { crashRate: 0.035, userPerceivedCrashRate: 0.012, distinctUsers: 800 };
  const anrMetrics = fixtures.anrMetrics ?? { anrRate: 0.001, userPerceivedAnrRate: 0.0003, distinctUsers: 800 };
  const previousIssues = fixtures.previousIssues ?? [issue("issue-top", { distinctUsers: "20", errorReportCount: "40" })];
  const userPerceivedIssues = fixtures.userPerceivedIssues ?? [issue("issue-top", { distinctUsers: "60", errorReportCount: "90" })];
  const currentIssues =
    fixtures.currentIssues ??
    [
      issue("issue-top", {
        distinctUsers: "120",
        errorReportCount: "260",
        lastErrorReportTime: "2026-06-23T10:00:00Z"
      })
    ];
  const anomalies =
    fixtures.anomalies ??
    [
      {
        name: "apps/com.example.app/anomalies/anomaly-crash",
        metricSet: "apps/com.example.app/crashRateMetricSet",
        timelineSpec: {
          aggregationPeriod: "DAILY",
          startTime: { year: 2026, month: 6, day: 22, timeZone: { id: "America/Los_Angeles" } },
          endTime: { year: 2026, month: 6, day: 23, timeZone: { id: "America/Los_Angeles" } }
        },
        dimensions: [{ dimension: "versionCode", int64Value: "123" }],
        metric: {
          metric: "userPerceivedCrashRate",
          decimalValue: { value: "0.012" }
        }
      } satisfies PlayAnomaly
    ];

  return {
    queryMetrics: vi.fn(async (_packageName, query) => {
      if (query.metricSet === "crashRateMetricSet") {
        return {
          rows: [metricRow("2026-06-22", crashMetrics)]
        };
      }

      if (query.metricSet === "anrRateMetricSet") {
        return {
          rows: [metricRow("2026-06-22", anrMetrics)]
        };
      }

      return { rows: [] };
    }),
    searchIssues: vi.fn(async (_packageName, options) => {
      const filter = options?.filter ?? "";

      if (options?.interval?.endDateExclusive === "2026-06-20") {
        return { reports: previousIssues };
      }

      if (filter.includes("isUserPerceived")) {
        return { reports: userPerceivedIssues };
      }

      return {
        reports: currentIssues
      };
    }),
    searchReports: vi.fn(),
    listAnomalies: vi.fn(async () => ({
      reports: anomalies
    }))
  };
}

function mockPublisherClient(fixtures: { releases: PlayRelease[]; reviews: PlayReview[] }): PlayPublisherClient {
  return {
    listTracks: vi.fn(),
    getTrack: vi.fn(),
    listReleases: vi.fn(async () => fixtures.releases),
    listReviews: vi.fn(async () => ({ reviews: fixtures.reviews }))
  };
}

function release(): PlayRelease {
  return {
    name: "1.2.3 production",
    versionCodes: ["123"],
    status: "inProgress",
    userFraction: 0.25
  };
}

function metricRow(date: string, metrics: Record<string, number>): PlayMetricRow {
  const [year, month, day] = date.split("-").map(Number);

  return {
    aggregationPeriod: "DAILY",
    startTime: {
      year,
      month,
      day,
      timeZone: { id: "America/Los_Angeles" }
    },
    dimensions: {},
    metrics
  };
}

function issue(
  id: string,
  options: {
    distinctUsers: string;
    errorReportCount: string;
    lastErrorReportTime?: string;
  }
): PlayErrorIssue {
  return {
    name: `apps/com.example.app/errorIssues/${id}`,
    type: "crash",
    cause: "IllegalStateException",
    location: "com.example.MainActivity.onCreate",
    distinctUsers: options.distinctUsers,
    errorReportCount: options.errorReportCount,
    lastErrorReportTime: options.lastErrorReportTime
  };
}

function review(
  reviewId: string,
  options: {
    text: string;
    modified: string;
    rating: number;
    versionCode: string;
  }
): PlayReview {
  return {
    reviewId,
    comments: [
      {
        userComment: {
          text: options.text,
          lastModified: { seconds: String(Math.floor(Date.parse(options.modified) / 1000)) },
          starRating: options.rating,
          appVersionCode: options.versionCode,
          thumbsUpCount: 0,
          thumbsDownCount: 0
        }
      }
    ]
  };
}
