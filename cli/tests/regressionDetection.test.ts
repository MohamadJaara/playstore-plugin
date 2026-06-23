import { describe, expect, it, vi } from "vitest";

import { compareReleases, formatCompareReleasesMarkdown } from "../src/commands/compare.js";
import type { PlayReportingClient } from "../src/clients/playReportingClient.js";
import { aggregateReleaseHealthMetricGroup } from "../src/domain/releaseHealth.js";
import { detectReleaseRegressions } from "../src/domain/regressionDetection.js";
import type { PlaystoreConfig } from "../src/config.js";
import type { PlayErrorIssue, PlayMetricRow } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("detectReleaseRegressions", () => {
  it("reports metric deltas between current and previous releases", () => {
    const result = detectReleaseRegressions({
      currentMetricGroups: [metricGroup("crash", 0.025, 0.007, 1_000), metricGroup("anr", 0.002, 0.001, 1_000)],
      previousMetricGroups: [metricGroup("crash", 0.01, 0.001, 1_000), metricGroup("anr", 0.001, 0.0005, 1_000)],
      currentIssues: [],
      previousIssues: [],
      limit: 20
    });

    const crash = result.metrics.find((metric) => metric.signal === "crash");
    const anr = result.metrics.find((metric) => metric.signal === "anr");

    expect(crash).toMatchObject({
      severity: "high-risk",
      current: {
        rate: 0.025,
        userPerceivedRate: 0.007,
        distinctUserDays: 1000
      },
      previous: {
        rate: 0.01,
        userPerceivedRate: 0.001,
        distinctUserDays: 1000
      },
      deltas: {
        rate: {
          absoluteDelta: 0.015,
          worsened: true
        },
        userPerceivedRate: {
          absoluteDelta: 0.006,
          worsened: true
        }
      }
    });
    expect(anr).toMatchObject({
      severity: "monitor",
      deltas: {
        rate: {
          absoluteDelta: 0.001,
          worsened: true
        }
      }
    });
  });

  it("detects new, resurfaced, fixed, and worsened issues", () => {
    const result = detectReleaseRegressions({
      currentMetricGroups: [],
      previousMetricGroups: [],
      currentIssues: [
        issue("new-high", { distinctUsers: "80", errorReportCount: "130" }),
        issue("resurfaced", { distinctUsers: "16", errorReportCount: "24" }),
        issue("worse", { distinctUsers: "45", errorReportCount: "90" }),
        issue("same-low", { distinctUsers: "2", errorReportCount: "2" })
      ],
      previousIssues: [
        issue("worse", { distinctUsers: "15", errorReportCount: "30" }),
        issue("fixed", { distinctUsers: "25", errorReportCount: "40" }),
        issue("same-low", { distinctUsers: "1", errorReportCount: "1" })
      ],
      historicalIssues: [issue("resurfaced", { distinctUsers: "4", errorReportCount: "8" })],
      currentUserPerceivedIssues: [
        issue("new-high", { distinctUsers: "35", errorReportCount: "50" }),
        issue("worse", { distinctUsers: "8", errorReportCount: "12" })
      ],
      previousUserPerceivedIssues: [issue("worse", { distinctUsers: "1", errorReportCount: "2" })],
      limit: 20
    });

    expect(result.issues.newIssues.map((entry) => entry.issueId)).toEqual(["new-high"]);
    expect(result.issues.resurfacedIssues.map((entry) => entry.issueId)).toEqual(["resurfaced"]);
    expect(result.issues.worsenedIssues.map((entry) => entry.issueId)).toEqual(["worse"]);
    expect(result.issues.fixedIssues.map((entry) => entry.issueId)).toEqual(["fixed"]);
    expect(result.issues.unchangedCount).toBe(1);
    expect(result.issues.newIssues[0]).toMatchObject({
      severity: "high-risk",
      current: {
        affectedUsers: 80,
        eventCount: 130,
        userPerceivedAffectedUsers: 35
      }
    });
    expect(result.issues.resurfacedIssues[0]).toMatchObject({
      classification: "resurfaced",
      severity: "investigate",
      historical: {
        affectedUsers: 4,
        eventCount: 8
      }
    });
    expect(result.issues.worsenedIssues[0]).toMatchObject({
      deltas: {
        affectedUsersDelta: 30,
        eventCountDelta: 60,
        affectedUsersRatio: 3,
        eventCountRatio: 3
      }
    });
  });

  it("keeps noisy low-volume issue and metric changes at monitor severity", () => {
    const result = detectReleaseRegressions({
      currentMetricGroups: [metricGroup("crash", 0.5, 0.5, 3)],
      previousMetricGroups: [metricGroup("crash", 0.01, 0.01, 3)],
      currentIssues: [issue("tiny-new", { distinctUsers: "1", errorReportCount: "2" })],
      previousIssues: [],
      limit: 20
    });

    expect(result.metrics[0]).toMatchObject({
      signal: "crash",
      severity: "monitor",
      current: {
        distinctUserDays: 3
      },
      deltas: {
        rate: {
          worsened: true
        }
      }
    });
    expect(result.issues.newIssues[0]).toMatchObject({
      issueId: "tiny-new",
      severity: "monitor",
      current: {
        affectedUsers: 1,
        eventCount: 2
      }
    });
    expect(result.issues.lowVolumeMonitorCount).toBe(1);
  });

  it("does not use capped issue searches as proof of absence", () => {
    const result = detectReleaseRegressions({
      currentMetricGroups: [],
      previousMetricGroups: [],
      currentIssues: [issue("maybe-new", { distinctUsers: "80", errorReportCount: "120" })],
      previousIssues: [issue("maybe-fixed", { distinctUsers: "90", errorReportCount: "140" })],
      issueSearchCompleteness: {
        current: false,
        previous: false,
        historical: true
      },
      limit: 20
    });

    expect(result.issues.newIssues).toEqual([]);
    expect(result.issues.resurfacedIssues).toEqual([]);
    expect(result.issues.fixedIssues).toEqual([]);
    expect(result.issues.unchangedCount).toBe(2);
  });

  it("keeps the largest fixed issue impact before applying the limit", () => {
    const result = detectReleaseRegressions({
      currentMetricGroups: [],
      previousMetricGroups: [],
      currentIssues: [],
      previousIssues: [
        issue("small-fixed", { distinctUsers: "1", errorReportCount: "3" }),
        issue("large-fixed", { distinctUsers: "200", errorReportCount: "400" })
      ],
      limit: 1
    });

    expect(result.issues.fixedIssues.map((entry) => entry.issueId)).toEqual(["large-fixed"]);
  });
});

describe("compareReleases", () => {
  it("queries release metrics and issue windows, then generates concrete Markdown actions", async () => {
    const client = mockReportingClient();
    const output = await compareReleases(
      {
        packageName: undefined,
        track: "production",
        currentVersionCodes: ["200"],
        previousVersionCodes: ["199"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        limit: 10,
        format: "json"
      },
      { config, client }
    );

    expect(client.queryMetrics).toHaveBeenCalledTimes(4);
    expect(client.queryMetrics).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        metricSet: "crashRateMetricSet",
        filter: "versionCode = 200",
        metrics: ["crashRate", "userPerceivedCrashRate", "distinctUsers"]
      })
    );
    expect(client.searchIssues).toHaveBeenCalledTimes(12);
    expect(client.searchIssues).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        interval: {
          startDate: "2026-06-08",
          endDateExclusive: "2026-06-15"
        },
        filter: "versionCode = 200 AND (errorIssueType = CRASH OR errorIssueType = ANR)",
        sampleErrorReportLimit: 1
      })
    );
    expect(output.summary).toMatchObject({
      highestSeverity: "high-risk",
      regressionCount: 3,
      metricRegressionCount: 1,
      fixedCount: 1
    });
    expect(output.issues).toMatchObject({
      newIssues: [expect.objectContaining({ issueId: "new-high" })],
      fixedIssues: [expect.objectContaining({ issueId: "fixed" })]
    });
    expect(output.summary.nextActions.join("\n")).toContain("scripts/playstore reports list");
    expect(output.summary.nextActions.join("\n")).toContain("scripts/playstore health release");

    const markdown = formatCompareReleasesMarkdown(output);

    expect(markdown).toContain("# Play Store Release Regression Report");
    expect(markdown).toContain("## What Got Worse");
    expect(markdown).toContain("scripts/playstore reports list");
    expect(markdown).toContain("## Fixed Or No Longer Observed");
  });

  it("continues issue searches across pages before comparing absence-based changes", async () => {
    const client = mockPagedReportingClient();
    const output = await compareReleases(
      {
        packageName: "com.example.app",
        track: "production",
        currentVersionCodes: ["200"],
        previousVersionCodes: ["199"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        limit: 10,
        format: "json"
      },
      { config, client }
    );

    expect(client.searchIssues).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        pageToken: "current-page-2"
      })
    );
    expect(output.issues.newIssues.map((entry) => entry.issueId)).toEqual(["paged-new"]);
  });

  it("warns and suppresses absence-based labels when issue search caps are exhausted", async () => {
    const client = mockCappedReportingClient();
    const output = await compareReleases(
      {
        packageName: "com.example.app",
        track: "production",
        currentVersionCodes: ["200"],
        previousVersionCodes: ["199"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        limit: 10,
        format: "json"
      },
      { config, client, issueSearchMaxResultsPerOrder: 1 }
    );

    expect(output.issues.newIssues).toEqual([]);
    expect(output.issues.fixedIssues).toEqual([]);
    expect(output.warnings.join("\n")).toContain("cap before all pages were read");
    expect(output.warnings.join("\n")).toContain("absence-based labels that depend on this search were suppressed");
  });

  it("uses non-suppression wording when only user-perceived issue searches cap", async () => {
    const client = mockUserPerceivedCappedReportingClient();
    const output = await compareReleases(
      {
        packageName: "com.example.app",
        track: "production",
        currentVersionCodes: ["200"],
        previousVersionCodes: ["199"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        limit: 10,
        format: "json"
      },
      { config, client, issueSearchMaxResultsPerOrder: 1 }
    );

    expect(output.issues.newIssues.map((entry) => entry.issueId)).toEqual(["new-with-capped-impact"]);
    expect(output.warnings.join("\n")).toContain("user-perceived impact counts may be incomplete");
    expect(output.warnings.join("\n")).not.toContain("absence-based labels that depend on this search were suppressed");
  });
});

function mockReportingClient(): PlayReportingClient {
  return {
    queryMetrics: vi.fn(async (_packageName, query) => {
      const versionCode = query.filter?.match(/\d+/)?.[0];

      if (query.metricSet === "crashRateMetricSet" && versionCode === "200") {
        return {
          rows: [metricRow("2026-06-08", { crashRate: 0.03, userPerceivedCrashRate: 0.006, distinctUsers: 500 })]
        };
      }

      if (query.metricSet === "crashRateMetricSet" && versionCode === "199") {
        return {
          rows: [metricRow("2026-06-08", { crashRate: 0.01, userPerceivedCrashRate: 0.001, distinctUsers: 500 })]
        };
      }

      if (query.metricSet === "anrRateMetricSet" && versionCode === "200") {
        return {
          rows: [metricRow("2026-06-08", { anrRate: 0.001, userPerceivedAnrRate: 0.0005, distinctUsers: 500 })]
        };
      }

      if (query.metricSet === "anrRateMetricSet" && versionCode === "199") {
        return {
          rows: [metricRow("2026-06-08", { anrRate: 0.001, userPerceivedAnrRate: 0.0005, distinctUsers: 500 })]
        };
      }

      return { rows: [] };
    }),
    searchIssues: vi.fn(async (_packageName, options) => {
      const filter = options?.filter ?? "";
      const historical = options?.interval?.endDateExclusive === "2026-06-08";
      const userPerceived = filter.includes("isUserPerceived");

      if (historical) {
        return { reports: userPerceived ? [] : [issue("resurfaced", { distinctUsers: "3", errorReportCount: "4" })] };
      }

      if (filter.includes("versionCode = 200")) {
        return {
          reports: userPerceived
            ? [issue("new-high", { distinctUsers: "30", errorReportCount: "40" })]
            : [
                issue("new-high", { distinctUsers: "60", errorReportCount: "100" }),
                issue("resurfaced", { distinctUsers: "12", errorReportCount: "25" })
              ]
        };
      }

      if (filter.includes("versionCode = 199")) {
        return { reports: userPerceived ? [] : [issue("fixed", { distinctUsers: "18", errorReportCount: "30" })] };
      }

      return { reports: [] };
    }),
    searchReports: vi.fn(),
    listAnomalies: vi.fn()
  };
}

function mockPagedReportingClient(): PlayReportingClient {
  return {
    queryMetrics: vi.fn(async () => ({ rows: [] })),
    searchIssues: vi.fn(async (_packageName, options) => {
      const filter = options?.filter ?? "";

      if (
        filter.includes("versionCode = 200") &&
        !filter.includes("isUserPerceived") &&
        options?.interval?.startDate === "2026-06-08" &&
        options?.orderBy === "distinctUsers desc" &&
        !options.pageToken
      ) {
        return { reports: [], nextPageToken: "current-page-2" };
      }

      if (options?.pageToken === "current-page-2") {
        return { reports: [issue("paged-new", { distinctUsers: "40", errorReportCount: "70" })] };
      }

      return { reports: [] };
    }),
    searchReports: vi.fn(),
    listAnomalies: vi.fn()
  };
}

function mockCappedReportingClient(): PlayReportingClient {
  return {
    queryMetrics: vi.fn(async () => ({ rows: [] })),
    searchIssues: vi.fn(async (_packageName, options) => {
      const filter = options?.filter ?? "";

      if (filter.includes("isUserPerceived")) {
        return { reports: [] };
      }

      if (filter.includes("versionCode = 200") && !options?.pageToken) {
        return {
          reports: [issue("maybe-new", { distinctUsers: "60", errorReportCount: "100" })],
          nextPageToken: "current-capped"
        };
      }

      if (filter.includes("versionCode = 199") && !options?.pageToken) {
        return {
          reports: [issue("maybe-fixed", { distinctUsers: "80", errorReportCount: "130" })],
          nextPageToken: "previous-capped"
        };
      }

      return { reports: [] };
    }),
    searchReports: vi.fn(),
    listAnomalies: vi.fn()
  };
}

function mockUserPerceivedCappedReportingClient(): PlayReportingClient {
  return {
    queryMetrics: vi.fn(async () => ({ rows: [] })),
    searchIssues: vi.fn(async (_packageName, options) => {
      const filter = options?.filter ?? "";

      if (
        filter.includes("isUserPerceived") &&
        filter.includes("versionCode = 200") &&
        options?.interval?.startDate === "2026-06-08" &&
        !options?.pageToken
      ) {
        return {
          reports: [issue("new-with-capped-impact", { distinctUsers: "12", errorReportCount: "15" })],
          nextPageToken: "user-perceived-capped"
        };
      }

      if (filter.includes("versionCode = 200") && options?.interval?.startDate === "2026-06-08") {
        return {
          reports: [issue("new-with-capped-impact", { distinctUsers: "40", errorReportCount: "80" })]
        };
      }

      return { reports: [] };
    }),
    searchReports: vi.fn(),
    listAnomalies: vi.fn()
  };
}

function metricGroup(signal: "crash" | "anr", rate: number, userPerceivedRate: number, distinctUsers: number) {
  const config =
    signal === "crash"
      ? {
          signal,
          metricSet: "crashRateMetricSet",
          rateMetric: "crashRate",
          userPerceivedRateMetric: "userPerceivedCrashRate"
        }
      : {
          signal,
          metricSet: "anrRateMetricSet",
          rateMetric: "anrRate",
          userPerceivedRateMetric: "userPerceivedAnrRate"
        };

  return aggregateReleaseHealthMetricGroup(
    config,
    [
      {
        versionCode: "200",
        row: metricRow("2026-06-08", {
          [config.rateMetric]: rate,
          [config.userPerceivedRateMetric]: userPerceivedRate,
          distinctUsers
        })
      }
    ],
    []
  );
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
  overrides: Partial<PlayErrorIssue> & Pick<Partial<PlayErrorIssue>, "distinctUsers" | "errorReportCount"> = {}
): PlayErrorIssue {
  return {
    name: `apps/com.example.app/errorIssues/${id}`,
    type: "crash",
    cause: "IllegalStateException",
    location: "com.example.MainActivity.onCreate",
    firstAppVersion: { versionCode: "199" },
    lastAppVersion: { versionCode: "200" },
    firstOsVersion: { apiLevel: "31" },
    lastOsVersion: { apiLevel: "35" },
    lastErrorReportTime: "2026-06-14T12:00:00Z",
    distinctUsers: "0",
    errorReportCount: "0",
    sampleErrorReports: [`apps/com.example.app/errorReports/${id}-sample`],
    ...overrides
  };
}
