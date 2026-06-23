import { describe, expect, it, vi } from "vitest";

import { buildIssueSearchFilter, listIssues } from "../src/commands/issues.js";
import { buildReportsSearchFilter, listReports } from "../src/commands/reports.js";
import type { PlayReportingClient } from "../src/clients/playReportingClient.js";
import { issueIdFromName, rankIssues } from "../src/domain/issueRanking.js";
import type { PlaystoreConfig } from "../src/config.js";
import type { PlayErrorIssue, PlayErrorReport } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("issue ranking", () => {
  it("ranks by affected users, event count, growth, recency, and user-perceived impact", () => {
    const ranked = rankIssues({
      currentIssues: [
        issue("issue-a", {
          distinctUsers: "100",
          errorReportCount: "100",
          lastErrorReportTime: "2026-06-14T10:00:00Z"
        }),
        issue("issue-b", {
          distinctUsers: "70",
          errorReportCount: "80",
          lastErrorReportTime: "2026-06-14T12:00:00Z"
        }),
        issue("issue-c", {
          distinctUsers: "200",
          errorReportCount: "300",
          lastErrorReportTime: "2026-06-08T00:00:00Z"
        })
      ],
      previousIssues: [
        issue("issue-a", { distinctUsers: "100", errorReportCount: "100" }),
        issue("issue-b", { distinctUsers: "5", errorReportCount: "10" }),
        issue("issue-c", { distinctUsers: "190", errorReportCount: "290" })
      ],
      userPerceivedIssues: [issue("issue-b", { distinctUsers: "40", errorReportCount: "50" })],
      dateRange: {
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15"
      },
      stateFilter: "all",
      limit: 3
    });

    expect(ranked.map((entry) => entry.issueId)).toEqual(["issue-b", "issue-c", "issue-a"]);
    expect(ranked[0]).toMatchObject({
      issueId: "issue-b",
      current: {
        affectedUsers: 70,
        eventCount: 80
      },
      previous: {
        affectedUsers: 5,
        eventCount: 10
      },
      growth: {
        affectedUsersDelta: 65,
        eventCountDelta: 70,
        affectedUsersRatio: 14,
        eventCountRatio: 8
      },
      impact: {
        userPerceived: true,
        userPerceivedAffectedUsers: 40,
        userPerceivedEventCount: 50
      },
      rank: {
        position: 1
      }
    });
    expect(ranked[0].rank.factors).toMatchObject({
      growth: 1,
      userPerceived: 1
    });
    expect(ranked[0].rank.score).toBeGreaterThan(ranked[1].rank.score);
  });

  it("filters derived issue states without depending on unavailable Play lifecycle state", () => {
    const ranked = rankIssues({
      currentIssues: [
        issue("open", { lastErrorReportTime: "2026-06-14T23:00:00Z" }),
        issue("unknown", { lastErrorReportTime: "not-a-date" })
      ],
      dateRange: {
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15"
      },
      stateFilter: "unknown",
      limit: 10
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      issueId: "unknown",
      state: "unknown"
    });
  });

  it("uses the Reporting API timezone for derived open state boundaries", () => {
    const ranked = rankIssues({
      currentIssues: [
        issue("still-june-14-in-la", { lastErrorReportTime: "2026-06-15T06:00:00Z" }),
        issue("june-15-in-la", { lastErrorReportTime: "2026-06-15T07:00:00Z" }),
        issue("before-start-in-la", { lastErrorReportTime: "2026-06-08T06:59:59Z" })
      ],
      dateRange: {
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15"
      },
      stateFilter: "open",
      limit: 10
    });

    expect(ranked.map((entry) => entry.issueId)).toEqual(["still-june-14-in-la"]);
    expect(ranked[0]).toMatchObject({
      state: "open",
      lastErrorReportTime: "2026-06-15T06:00:00Z"
    });
  });
});

describe("issue and report command helpers", () => {
  it("builds Reporting API filters for version codes, crash/ANR types, and issue ids", () => {
    expect(buildIssueSearchFilter(["123", "124"], "all")).toBe(
      "(versionCode = 123 OR versionCode = 124) AND (errorIssueType = CRASH OR errorIssueType = ANR)"
    );
    expect(buildIssueSearchFilter(["123"], "anr")).toBe("versionCode = 123 AND errorIssueType = ANR");
    expect(buildReportsSearchFilter("issue-1", ["123"], "crash")).toBe(
      'errorIssueId = "issue-1" AND versionCode = 123 AND errorIssueType = CRASH'
    );
    expect(issueIdFromName("apps/com.example.app/errorIssues/9876")).toBe("9876");
  });

  it("lists ranked issues using current, previous, and user-perceived read-only searches", async () => {
    const client = mockReportingClient({
      currentIssues: [
        issue("issue-a", { distinctUsers: "100", errorReportCount: "100", lastErrorReportTime: "2026-06-14T10:00:00Z" }),
        issue("issue-b", { distinctUsers: "70", errorReportCount: "80", lastErrorReportTime: "2026-06-14T12:00:00Z" })
      ],
      previousIssues: [
        issue("issue-a", { distinctUsers: "100", errorReportCount: "100" }),
        issue("issue-b", { distinctUsers: "5", errorReportCount: "10" })
      ],
      userPerceivedIssues: [issue("issue-b", { distinctUsers: "40", errorReportCount: "50" })],
      reports: []
    });

    const output = await listIssues(
      {
        packageName: undefined,
        versionCodes: ["123", "124"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        state: "all",
        limit: 2,
        format: "json"
      },
      { config, client }
    );

    expect(client.searchIssues).toHaveBeenCalledTimes(6);
    expect(client.searchIssues).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        interval: {
          startDate: "2026-06-08",
          endDateExclusive: "2026-06-15"
        },
        filter: "(versionCode = 123 OR versionCode = 124) AND (errorIssueType = CRASH OR errorIssueType = ANR)",
        sampleErrorReportLimit: 1
      })
    );
    expect(output.dateRange).toMatchObject({
      startDate: "2026-06-08",
      endDateExclusive: "2026-06-15",
      previousStartDate: "2026-06-01",
      previousEndDateExclusive: "2026-06-08",
      timeZone: "America/Los_Angeles"
    });
    expect(output.issues.map((entry) => entry.issueId)).toEqual(["issue-b", "issue-a"]);
    expect(output.issues[0].impact.userPerceived).toBe(true);
  });

  it("lists representative reports and extracts stack traces without returning raw report text", async () => {
    const reportText = [
      "java.lang.IllegalStateException: Bad state",
      "    at com.example.MainActivity.onCreate(MainActivity.kt:42)",
      "    at android.app.Activity.performCreate(Activity.java:9000)"
    ].join("\n");
    const client = mockReportingClient({
      currentIssues: [],
      previousIssues: [],
      userPerceivedIssues: [],
      reports: [
        {
          name: "apps/com.example.app/errorReports/report-1",
          issue: "apps/com.example.app/errorIssues/issue-1",
          type: "crash",
          appVersion: { versionCode: "123" },
          osVersion: { apiLevel: "35" },
          deviceModel: {
            marketingName: "Pixel 8",
            deviceId: {
              buildBrand: "google",
              buildDevice: "shiba"
            }
          },
          eventTime: "2026-06-14T12:00:00Z",
          reportText
        }
      ]
    });

    const output = await listReports(
      {
        packageName: "com.example.app",
        issueId: "issue-1",
        versionCodes: ["123"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-15",
        type: "all",
        limit: 5,
        format: "json"
      },
      { config, client }
    );

    expect(client.searchReports).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        interval: {
          startDate: "2026-06-08",
          endDateExclusive: "2026-06-15"
        },
        filter: 'errorIssueId = "issue-1" AND versionCode = 123 AND (errorIssueType = CRASH OR errorIssueType = ANR)',
        pageSize: 5
      })
    );
    expect(output.reports[0]).toMatchObject({
      reportId: "report-1",
      issueId: "issue-1",
      versionCode: "123",
      stackTrace: {
        exceptionType: "java.lang.IllegalStateException"
      }
    });
    expect(output.reports[0].stackTrace.frames[0]).toMatchObject({
      declaringClass: "com.example.MainActivity",
      method: "onCreate",
      file: "MainActivity.kt",
      line: 42
    });
    expect(Object.keys(output.reports[0])).not.toContain("reportText");
  });
});

function mockReportingClient(fixtures: {
  currentIssues: PlayErrorIssue[];
  previousIssues: PlayErrorIssue[];
  userPerceivedIssues: PlayErrorIssue[];
  reports: PlayErrorReport[];
}): PlayReportingClient {
  return {
    queryMetrics: vi.fn(),
    searchIssues: vi.fn(async (_packageName, options) => {
      if (options?.filter?.includes("isUserPerceived")) {
        return { reports: fixtures.userPerceivedIssues };
      }

      if (options?.interval?.endDateExclusive === "2026-06-08") {
        return { reports: fixtures.previousIssues };
      }

      return { reports: fixtures.currentIssues };
    }),
    searchReports: vi.fn(async () => ({ reports: fixtures.reports })),
    listAnomalies: vi.fn()
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
    firstAppVersion: { versionCode: "123" },
    lastAppVersion: { versionCode: "123" },
    firstOsVersion: { apiLevel: "31" },
    lastOsVersion: { apiLevel: "35" },
    distinctUsers: "0",
    errorReportCount: "0",
    sampleErrorReports: [`apps/com.example.app/errorReports/${id}-sample`],
    ...overrides
  };
}
