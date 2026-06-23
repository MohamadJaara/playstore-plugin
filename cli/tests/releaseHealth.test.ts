import { describe, expect, it, vi } from "vitest";

import { getReleaseHealth, parsePositiveInteger } from "../src/commands/health.js";
import {
  aggregateReleaseHealthMetricGroup,
  buildReleaseHealthTimelineSpec,
  buildVersionCodeFilter
} from "../src/domain/releaseHealth.js";
import { healthReleaseInputSchema } from "../src/schemas/cliInputs.js";
import type { PlayReportingClient } from "../src/clients/playReportingClient.js";
import type { PlaystoreConfig } from "../src/config.js";
import type { PlayMetricRow } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("release health date range helpers", () => {
  it("builds daily Reporting API timeline specs and version-code filters", () => {
    expect(buildReleaseHealthTimelineSpec("2026-06-01", "2026-06-08")).toEqual({
      aggregationPeriod: "DAILY",
      startTime: {
        year: 2026,
        month: 6,
        day: 1,
        timeZone: { id: "America/Los_Angeles" }
      },
      endTime: {
        year: 2026,
        month: 6,
        day: 8,
        timeZone: { id: "America/Los_Angeles" }
      }
    });
    expect(buildVersionCodeFilter("123")).toBe("versionCode = 123");
  });

  it("rejects invalid or empty health date ranges", () => {
    expect(() =>
      healthReleaseInputSchema.parse({
        versionCodes: ["123"],
        startDate: "2026-06-08",
        endDateExclusive: "2026-06-01",
        dimensions: [],
        format: "json"
      })
    ).toThrow();
    expect(() =>
      healthReleaseInputSchema.parse({
        versionCodes: ["123"],
        startDate: "2026-02-30",
        endDateExclusive: "2026-03-01",
        dimensions: [],
        format: "json"
      })
    ).toThrow();
  });
});

describe("health release command option parsing", () => {
  it("accepts positive whole-number days", () => {
    expect(parsePositiveInteger("7")).toBe(7);
  });

  it.each(["7abc", "1.5", "0", "-1", "9007199254740992"])("rejects malformed days value %s", (value) => {
    expect(() => parsePositiveInteger(value)).toThrow();
  });
});

describe("aggregateReleaseHealthMetricGroup", () => {
  it("uses distinct-user weighted averages for release metric summaries and slices", () => {
    const group = aggregateReleaseHealthMetricGroup(
      {
        signal: "crash",
        metricSet: "crashRateMetricSet",
        rateMetric: "crashRate",
        userPerceivedRateMetric: "userPerceivedCrashRate"
      },
      [
        {
          versionCode: "123",
          row: metricRow("2026-06-01", { crashRate: 0.02, userPerceivedCrashRate: 0.01, distinctUsers: 100 })
        },
        {
          versionCode: "124",
          row: metricRow("2026-06-01", { crashRate: 0.04, userPerceivedCrashRate: 0.02, distinctUsers: 300 })
        }
      ],
      ["apiLevel", "countryCode"]
    );

    expect(group.summary.rate).toMatchObject({
      value: 0.035,
      aggregation: "distinctUsersWeightedAverage",
      dataPoints: 2,
      missingPoints: 0
    });
    expect(group.summary.userPerceivedRate.value).toBe(0.0175);
    expect(group.summary.distinctUsers.userDays).toBe(400);
    expect(group.slices).toHaveLength(1);
    expect(group.slices[0]).toMatchObject({
      dimensions: {
        apiLevel: "35",
        countryCode: "US"
      },
      dataPoints: 2
    });
  });

  it("keeps missing metric values explicit instead of treating them as zero", () => {
    const group = aggregateReleaseHealthMetricGroup(
      {
        signal: "crash",
        metricSet: "crashRateMetricSet",
        rateMetric: "crashRate",
        userPerceivedRateMetric: "userPerceivedCrashRate"
      },
      [
        {
          versionCode: "123",
          row: metricRow("2026-06-01", { crashRate: 0.02 })
        }
      ],
      []
    );

    expect(group.summary.rate).toMatchObject({
      value: 0.02,
      aggregation: "arithmeticMean",
      dataPoints: 1
    });
    expect(group.summary.userPerceivedRate).toMatchObject({
      value: null,
      aggregation: "unavailable",
      dataPoints: 0,
      missingPoints: 1
    });
    expect(group.summary.distinctUsers.userDays).toBeNull();
    expect(group.missingData).toEqual({
      rows: 1,
      rowsMissingAnyMetric: 1,
      metrics: {
        crashRate: 0,
        userPerceivedCrashRate: 1,
        distinctUsers: 1
      }
    });
  });
});

describe("getReleaseHealth", () => {
  it("queries crash and ANR metrics for each version code and returns trend-ready output", async () => {
    const client = mockReportingClient();

    const output = await getReleaseHealth(
      {
        packageName: undefined,
        track: "production",
        versionCodes: ["123", "124"],
        startDate: "2026-06-01",
        endDateExclusive: "2026-06-08",
        dimensions: ["apiLevel", "countryCode"],
        format: "json"
      },
      { config, client }
    );

    expect(client.queryMetrics).toHaveBeenCalledTimes(4);
    expect(client.queryMetrics).toHaveBeenCalledWith(
      "com.example.app",
      expect.objectContaining({
        metricSet: "crashRateMetricSet",
        dimensions: ["apiLevel", "countryCode"],
        metrics: ["crashRate", "userPerceivedCrashRate", "distinctUsers"],
        filter: "versionCode = 123",
        pageSize: 100_000
      })
    );
    expect(output).toMatchObject({
      packageName: "com.example.app",
      track: "production",
      versionCodes: ["123", "124"],
      dateRange: {
        startDate: "2026-06-01",
        endDateExclusive: "2026-06-08",
        days: 7,
        aggregationPeriod: "DAILY",
        timeZone: "America/Los_Angeles"
      },
      dimensions: ["apiLevel", "countryCode"],
      warnings: []
    });

    const crash = output.metricGroups.find((group) => group.signal === "crash");
    const anr = output.metricGroups.find((group) => group.signal === "anr");

    expect(crash?.summary.rate.value).toBeCloseTo(0.035);
    expect(crash?.summary.userPerceivedRate.value).toBeCloseTo(0.0175);
    expect(crash?.series).toEqual([
      expect.objectContaining({
        date: "2026-06-01",
        versionCode: "123",
        dimensions: { apiLevel: "35", countryCode: "US" }
      }),
      expect.objectContaining({
        date: "2026-06-01",
        versionCode: "124",
        dimensions: { apiLevel: "35", countryCode: "US" }
      })
    ]);
    expect(anr?.summary.rate.value).toBeCloseTo(0.0125);
    expect(anr?.summary.userPerceivedRate.value).toBeCloseTo(0.0035);
  });
});

function mockReportingClient(): PlayReportingClient {
  return {
    queryMetrics: vi.fn(async (_packageName, query) => {
      const versionCode = query.filter?.match(/\d+/)?.[0];

      if (query.metricSet === "crashRateMetricSet" && versionCode === "123") {
        return {
          rows: [metricRow("2026-06-01", { crashRate: 0.02, userPerceivedCrashRate: 0.01, distinctUsers: 100 })]
        };
      }

      if (query.metricSet === "crashRateMetricSet" && versionCode === "124") {
        return {
          rows: [metricRow("2026-06-01", { crashRate: 0.04, userPerceivedCrashRate: 0.02, distinctUsers: 300 })]
        };
      }

      if (query.metricSet === "anrRateMetricSet" && versionCode === "123") {
        return {
          rows: [metricRow("2026-06-01", { anrRate: 0.005, userPerceivedAnrRate: 0.002, distinctUsers: 100 })]
        };
      }

      if (query.metricSet === "anrRateMetricSet" && versionCode === "124") {
        return {
          rows: [metricRow("2026-06-01", { anrRate: 0.015, userPerceivedAnrRate: 0.004, distinctUsers: 300 })]
        };
      }

      return { rows: [] };
    }),
    searchIssues: vi.fn(),
    searchReports: vi.fn(),
    listAnomalies: vi.fn()
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
    dimensions: {
      apiLevel: "35",
      countryCode: "US"
    },
    metrics
  };
}
