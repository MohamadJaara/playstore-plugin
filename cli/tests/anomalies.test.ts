import { describe, expect, it, vi } from "vitest";

import { buildAnomalyActiveBetweenFilter, listAnomalies, summarizeAnomaly } from "../src/commands/anomalies.js";
import type { PlayReportingClient } from "../src/clients/playReportingClient.js";
import type { PlaystoreConfig } from "../src/config.js";
import type { PlayAnomaly } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("anomalies list", () => {
  it("builds the read-only activeBetween anomaly filter", () => {
    expect(buildAnomalyActiveBetweenFilter("2026-06-20", "2026-06-24")).toBe(
      'activeBetween("2026-06-20T00:00:00-07:00", "2026-06-24T00:00:00-07:00")'
    );
  });

  it("summarizes anomaly dimensions, metrics, and signal type", () => {
    expect(
      summarizeAnomaly(
        anomaly("crash-1", {
          metricSet: "apps/com.example.app/crashRateMetricSet",
          metric: "userPerceivedCrashRate",
          value: "0.012",
          versionCode: "123",
          deviceModel: "google/shiba"
        })
      )
    ).toMatchObject({
      anomalyId: "crash-1",
      signal: "crash",
      metric: {
        name: "userPerceivedCrashRate",
        value: 0.012
      },
      dimensions: {
        versionCode: "123",
        deviceModel: "google/shiba"
      },
      dimensionLabels: {
        deviceModel: "Pixel 8"
      },
      versionCodes: ["123"]
    });
  });

  it("lists active anomalies and keeps app-wide anomalies when version filtering is requested", async () => {
    const client = mockReportingClient([
      anomaly("crash-123", {
        metricSet: "apps/com.example.app/crashRateMetricSet",
        metric: "userPerceivedCrashRate",
        value: "0.012",
        versionCode: "123"
      }),
      anomaly("anr-999", {
        metricSet: "apps/com.example.app/anrRateMetricSet",
        metric: "userPerceivedAnrRate",
        value: "0.008",
        versionCode: "999"
      }),
      anomaly("app-wide", {
        metricSet: "apps/com.example.app/crashRateMetricSet",
        metric: "crashRate",
        value: "0.02"
      })
    ]);

    const output = await listAnomalies(
      {
        packageName: undefined,
        versionCodes: ["123"],
        startDate: "2026-06-20",
        endDateExclusive: "2026-06-24",
        signal: "all",
        limit: 10,
        format: "json"
      },
      { config, client }
    );

    expect(client.listAnomalies).toHaveBeenCalledWith("com.example.app", {
      filter: 'activeBetween("2026-06-20T00:00:00-07:00", "2026-06-24T00:00:00-07:00")',
      pageSize: 100,
      pageToken: undefined
    });
    expect(output.anomalies.map((entry) => entry.anomalyId)).toEqual(["crash-123", "app-wide"]);
    expect(output.warnings.join("\n")).toContain("Version-code filtering is applied locally");
  });
});

function mockReportingClient(anomalies: PlayAnomaly[]): PlayReportingClient {
  return {
    queryMetrics: vi.fn(),
    searchIssues: vi.fn(),
    searchReports: vi.fn(),
    listAnomalies: vi.fn(async () => ({ reports: anomalies }))
  };
}

function anomaly(
  id: string,
  options: {
    metricSet: string;
    metric: string;
    value: string;
    versionCode?: string;
    deviceModel?: string;
  }
): PlayAnomaly {
  return {
    name: `apps/com.example.app/anomalies/${id}`,
    metricSet: options.metricSet,
    timelineSpec: {
      aggregationPeriod: "DAILY",
      startTime: { year: 2026, month: 6, day: 20, timeZone: { id: "America/Los_Angeles" } },
      endTime: { year: 2026, month: 6, day: 21, timeZone: { id: "America/Los_Angeles" } }
    },
    dimensions: [
      ...(options.versionCode ? [{ dimension: "versionCode", int64Value: options.versionCode }] : []),
      ...(options.deviceModel
        ? [{ dimension: "deviceModel", stringValue: options.deviceModel, valueLabel: "Pixel 8" }]
        : [])
    ],
    metric: {
      metric: options.metric,
      decimalValue: { value: options.value }
    }
  };
}
