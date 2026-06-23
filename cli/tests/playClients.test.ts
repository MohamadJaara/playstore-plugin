import { describe, expect, it, vi } from "vitest";

import { createPlayPublisherClient } from "../src/clients/playPublisherClient.js";
import { createPlayReportingClient } from "../src/clients/playReportingClient.js";
import { normalizeGooglePlayError, requestGooglePlay, type GooglePlayRequestClient } from "../src/clients/request.js";

describe("playPublisherClient", () => {
  it("lists tracks and normalizes releases", async () => {
    const requestClient = mockRequestClient({
      tracks: [
        {
          track: "production",
          releases: [
            {
              name: "Release 123",
              versionCodes: ["123"],
              status: "inProgress",
              userFraction: 0.2,
              releaseNotes: [{ language: "en-US", text: "Bug fixes" }]
            }
          ]
        }
      ]
    });

    const client = createPlayPublisherClient(requestClient);
    const tracks = await client.listTracks("com.example.app", "edit-1");

    expect(requestClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits/edit-1/tracks"
    });
    expect(tracks).toEqual([
      {
        track: "production",
        releases: [
          {
            name: "Release 123",
            versionCodes: ["123"],
            status: "inProgress",
            userFraction: 0.2,
            releaseNotes: [{ language: "en-US", text: "Bug fixes" }]
          }
        ]
      }
    ]);
  });

  it("lists releases from the direct track releases endpoint", async () => {
    const requestClient = mockRequestClient({
      releases: [
        {
          releaseName: "Release 456",
          track: "beta",
          activeArtifacts: [{ versionCode: 456 }, { versionCode: 457 }, {}, { versionCode: "" }],
          releaseLifecycleState: "RELEASED",
          userFraction: 0.5
        },
        {
          releaseName: "Metadata only",
          track: "beta",
          releaseLifecycleState: "DRAFT"
        }
      ]
    });

    const client = createPlayPublisherClient(requestClient);
    const releases = await client.listReleases("com.example.app", "beta");

    expect(requestClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/tracks/beta/releases"
    });
    expect(releases).toEqual([
      {
        name: "Release 456",
        versionCodes: ["456", "457"],
        status: "RELEASED",
        userFraction: 0.5,
        releaseNotes: []
      },
      {
        name: "Metadata only",
        versionCodes: [],
        status: "DRAFT",
        userFraction: undefined,
        releaseNotes: []
      }
    ]);
  });

  it("lists reviews and normalizes user comment metadata without using reply endpoints", async () => {
    const requestClient = mockRequestClient({
      reviews: [
        {
          reviewId: "review-1",
          authorName: "A reviewer",
          comments: [
            {
              userComment: {
                text: "Crashes on launch",
                originalText: "",
                lastModified: { seconds: "1782151200", nanos: 123000000 },
                starRating: 1,
                reviewerLanguage: "en",
                device: "shiba",
                androidOsVersion: 35,
                appVersionCode: 123,
                appVersionName: "1.2.3",
                thumbsUpCount: 4,
                thumbsDownCount: 1,
                deviceMetadata: {
                  productName: "Pixel 8",
                  manufacturer: "Google",
                  deviceClass: "phone"
                }
              }
            },
            {
              developerComment: {
                text: "Thanks for the report",
                lastModified: { seconds: "1782151300" }
              }
            }
          ]
        }
      ],
      tokenPagination: {
        nextPageToken: "next-token"
      }
    });

    const client = createPlayPublisherClient(requestClient);
    const page = await client.listReviews("com.example.app", {
      maxResults: 50,
      token: "page-token",
      translationLanguage: "en"
    });

    expect(requestClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/reviews",
      params: {
        token: "page-token",
        maxResults: 50,
        translationLanguage: "en"
      }
    });
    expect(page).toEqual({
      reviews: [
        {
          reviewId: "review-1",
          authorName: "A reviewer",
          comments: [
            {
              userComment: {
                text: "Crashes on launch",
                originalText: "",
                lastModified: { seconds: "1782151200", nanos: 123000000 },
                starRating: 1,
                reviewerLanguage: "en",
                device: "shiba",
                androidOsVersion: 35,
                appVersionCode: "123",
                appVersionName: "1.2.3",
                thumbsUpCount: 4,
                thumbsDownCount: 1,
                deviceMetadata: {
                  productName: "Pixel 8",
                  manufacturer: "Google",
                  deviceClass: "phone"
                }
              },
              developerComment: undefined
            },
            {
              userComment: undefined,
              developerComment: {
                text: "Thanks for the report",
                lastModified: { seconds: "1782151300" }
              }
            }
          ]
        }
      ],
      nextPageToken: "next-token"
    });
  });
});

describe("playReportingClient", () => {
  it("queries metrics and maps dimension and metric rows", async () => {
    const requestClient = mockRequestClient({
      rows: [
        {
          aggregationPeriod: "DAILY",
          startTime: {
            year: 2026,
            month: 6,
            day: 1,
            timeZone: { id: "America/Los_Angeles" }
          },
          dimensions: [
            { dimension: "versionCode", int64Value: "123" },
            { dimension: "deviceType", stringValue: "PHONE" }
          ],
          metrics: [{ metric: "crashRate", decimalValue: { value: "0.031" } }]
        }
      ],
      nextPageToken: "next"
    });

    const client = createPlayReportingClient(requestClient);
    const result = await client.queryMetrics("com.example.app", {
      metricSet: "crashRateMetricSet",
      dimensions: ["versionCode", "deviceType"],
      metrics: ["crashRate"],
      filter: "versionCode = 123"
    });

    expect(requestClient.request).toHaveBeenCalledWith({
      method: "POST",
      url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/crashRateMetricSet:query",
      data: {
        dimensions: ["versionCode", "deviceType"],
        metrics: ["crashRate"],
        filter: "versionCode = 123"
      }
    });
    expect(result).toEqual({
      rows: [
        {
          aggregationPeriod: "DAILY",
          startTime: {
            year: 2026,
            month: 6,
            day: 1,
            timeZone: { id: "America/Los_Angeles" }
          },
          dimensions: { versionCode: "123", deviceType: "PHONE" },
          metrics: { crashRate: 0.031 }
        }
      ],
      nextPageToken: "next"
    });
  });

  it("searches issues and reports with stable typed envelopes", async () => {
    const issuesClient = mockRequestClient({
      errorIssues: [
        {
          name: "apps/com.example.app/errorIssues/issue-1",
          type: "CRASH",
          cause: "IllegalArgumentException",
          location: "com.example.MainActivity.onCreate",
          errorReportCount: "12",
          distinctUsers: "9",
          distinctUsersPercent: { value: "0.25" },
          firstAppVersion: { versionCode: "120" },
          lastAppVersion: { versionCode: "123" },
          firstOsVersion: { apiLevel: "31" },
          lastOsVersion: { apiLevel: "35" },
          lastErrorReportTime: "2026-06-23T10:00:00Z",
          sampleErrorReports: ["apps/com.example.app/errorReports/report-1"],
          issueUri: "https://play.google.com/console"
        }
      ]
    });
    const reportsClient = mockRequestClient({
      errorReports: [
        {
          name: "apps/com.example.app/errorReports/report-1",
          issue: "apps/com.example.app/errorIssues/issue-1",
          type: "APPLICATION_NOT_RESPONDING",
          appVersion: { versionCode: "123" },
          osVersion: { apiLevel: "35" },
          deviceModel: {
            marketingName: "Pixel 8",
            deviceId: {
              buildBrand: "google",
              buildDevice: "shiba"
            }
          },
          eventTime: "2026-06-23T10:00:00Z",
          reportText: "main thread blocked",
          vcsInformation: "git-sha"
        }
      ]
    });

    await expect(createPlayReportingClient(issuesClient).searchIssues("com.example.app", { pageSize: 10 })).resolves.toEqual({
      reports: [
        {
          name: "apps/com.example.app/errorIssues/issue-1",
          type: "crash",
          cause: "IllegalArgumentException",
          location: "com.example.MainActivity.onCreate",
          errorReportCount: "12",
          distinctUsers: "9",
          distinctUsersPercent: "0.25",
          firstAppVersion: { versionCode: "120" },
          lastAppVersion: { versionCode: "123" },
          firstOsVersion: { apiLevel: "31" },
          lastOsVersion: { apiLevel: "35" },
          lastErrorReportTime: "2026-06-23T10:00:00Z",
          sampleErrorReports: ["apps/com.example.app/errorReports/report-1"],
          issueUri: "https://play.google.com/console"
        }
      ],
      nextPageToken: undefined
    });
    expect(issuesClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/errorIssues:search",
      params: { pageSize: 10 }
    });
    await expect(createPlayReportingClient(reportsClient).searchReports("com.example.app")).resolves.toEqual({
      reports: [
        {
          name: "apps/com.example.app/errorReports/report-1",
          issue: "apps/com.example.app/errorIssues/issue-1",
          type: "anr",
          appVersion: { versionCode: "123" },
          osVersion: { apiLevel: "35" },
          deviceModel: {
            marketingName: "Pixel 8",
            deviceId: {
              buildBrand: "google",
              buildDevice: "shiba"
            }
          },
          eventTime: "2026-06-23T10:00:00Z",
          reportText: "main thread blocked",
          vcsInformation: "git-sha"
        }
      ],
      nextPageToken: undefined
    });
  });

  it("passes date intervals to issue and report search endpoints as Google query params", async () => {
    const requestClient = mockRequestClient({});
    const client = createPlayReportingClient(requestClient);

    await client.searchIssues("com.example.app", {
      interval: {
        startDate: "2026-06-01",
        endDateExclusive: "2026-06-08"
      },
      filter: "versionCode = 123",
      pageSize: 10
    });
    await client.searchReports("com.example.app", {
      interval: {
        startDate: "2026-06-01",
        endDateExclusive: "2026-06-08"
      },
      filter: "errorIssueId = 9876",
      pageSize: 5
    });

    expect(requestClient.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/errorIssues:search",
      params: {
        "interval.startTime.year": 2026,
        "interval.startTime.month": 6,
        "interval.startTime.day": 1,
        "interval.startTime.timeZone.id": "America/Los_Angeles",
        "interval.endTime.year": 2026,
        "interval.endTime.month": 6,
        "interval.endTime.day": 8,
        "interval.endTime.timeZone.id": "America/Los_Angeles",
        filter: "versionCode = 123",
        pageSize: 10
      }
    });
    expect(requestClient.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/errorReports:search",
      params: {
        "interval.startTime.year": 2026,
        "interval.startTime.month": 6,
        "interval.startTime.day": 1,
        "interval.startTime.timeZone.id": "America/Los_Angeles",
        "interval.endTime.year": 2026,
        "interval.endTime.month": 6,
        "interval.endTime.day": 8,
        "interval.endTime.timeZone.id": "America/Los_Angeles",
        filter: "errorIssueId = 9876",
        pageSize: 5
      }
    });
  });

  it("lists anomalies with activeBetween filters and typed anomaly envelopes", async () => {
    const requestClient = mockRequestClient({
      anomalies: [
        {
          name: "apps/com.example.app/anomalies/anomaly-1",
          metricSet: "apps/com.example.app/crashRateMetricSet",
          timelineSpec: {
            aggregationPeriod: "DAILY",
            startTime: { year: 2026, month: 6, day: 20, timeZone: { id: "America/Los_Angeles" } },
            endTime: { year: 2026, month: 6, day: 21, timeZone: { id: "America/Los_Angeles" } }
          },
          dimensions: [
            { dimension: "versionCode", int64Value: "123" },
            { dimension: "deviceModel", stringValue: "google/shiba", valueLabel: "Pixel 8" }
          ],
          metric: {
            metric: "userPerceivedCrashRate",
            decimalValue: { value: "0.012" },
            decimalValueConfidenceInterval: {
              lowerBound: { value: "0.01" },
              upperBound: { value: "0.014" }
            }
          }
        }
      ],
      nextPageToken: "next"
    });
    const client = createPlayReportingClient(requestClient);

    await expect(
      client.listAnomalies("com.example.app", {
        filter: 'activeBetween("2026-06-20T00:00:00Z", "2026-06-21T00:00:00Z")',
        pageSize: 100,
        pageToken: "page-1"
      })
    ).resolves.toEqual({
      reports: [
        {
          name: "apps/com.example.app/anomalies/anomaly-1",
          metricSet: "apps/com.example.app/crashRateMetricSet",
          timelineSpec: {
            aggregationPeriod: "DAILY",
            startTime: { year: 2026, month: 6, day: 20, timeZone: { id: "America/Los_Angeles" } },
            endTime: { year: 2026, month: 6, day: 21, timeZone: { id: "America/Los_Angeles" } }
          },
          dimensions: [
            { dimension: "versionCode", int64Value: "123" },
            { dimension: "deviceModel", stringValue: "google/shiba", valueLabel: "Pixel 8" }
          ],
          metric: {
            metric: "userPerceivedCrashRate",
            decimalValue: { value: "0.012" },
            decimalValueConfidenceInterval: {
              lowerBound: { value: "0.01" },
              upperBound: { value: "0.014" }
            }
          }
        }
      ],
      nextPageToken: "next"
    });
    expect(requestClient.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/anomalies",
      params: {
        filter: 'activeBetween("2026-06-20T00:00:00Z", "2026-06-21T00:00:00Z")',
        pageSize: 100,
        pageToken: "page-1"
      }
    });
  });
});

describe("requestGooglePlay", () => {
  it("returns response data for successful requests", async () => {
    const requestClient = mockRequestClient({ ok: true });

    await expect(
      requestGooglePlay(requestClient, {
        method: "GET",
        url: "https://example.invalid/read-only"
      })
    ).resolves.toEqual({ ok: true });
  });

  it("normalizes Google API failures without leaking raw URLs or response messages", async () => {
    const requestClient: GooglePlayRequestClient = {
      request: vi.fn(async () => {
        throw {
          response: {
            status: 403,
            data: {
              error: {
                status: "PERMISSION_DENIED",
                message: "User cannot access com.secret.app"
              }
            }
          },
          config: {
            url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.secret.app/errorReports:search"
          }
        };
      })
    };

    await expect(
      requestGooglePlay(requestClient, {
        method: "POST",
        url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.secret.app/errorReports:search"
      })
    ).rejects.toMatchObject({
      code: "API_PERMISSION_DENIED",
      message: "Google Play API request failed with HTTP 403. API status: PERMISSION_DENIED."
    });

    await expect(
      requestGooglePlay(requestClient, {
        method: "POST",
        url: "https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.secret.app/errorReports:search"
      })
    ).rejects.not.toThrow("com.secret.app");
  });

  it("omits unrecognized response body status text from normalized errors", () => {
    const error = normalizeGooglePlayError({
      response: {
        status: 400,
        data: {
          error: {
            status: "PACKAGE_com.secret.app_TOKEN_123",
            message: "also sensitive"
          }
        }
      }
    });

    expect(error.message).toBe("Google Play API request failed with HTTP 400.");
  });

  it("maps retry-safe status codes to stable CLI errors", () => {
    expect(normalizeGooglePlayError(apiError(404)).code).toBe("API_NOT_FOUND");
    expect(normalizeGooglePlayError(apiError(429)).code).toBe("API_RATE_LIMITED");
    expect(normalizeGooglePlayError(apiError(503)).code).toBe("API_UNAVAILABLE");
    expect(normalizeGooglePlayError(new Error("socket hang up")).code).toBe("API_REQUEST_FAILED");
  });
});

function mockRequestClient<TResponse>(data: TResponse): GooglePlayRequestClient {
  return {
    request: vi.fn(async () => ({ data }))
  };
}

function apiError(status: number): unknown {
  return {
    response: {
      status,
      data: {
        error: {
          status: `HTTP_${status}`
        }
      }
    }
  };
}
