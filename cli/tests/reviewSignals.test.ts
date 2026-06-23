import { describe, expect, it, vi } from "vitest";

import { getRecentReviews } from "../src/commands/reviews.js";
import type { PlayPublisherClient } from "../src/clients/playPublisherClient.js";
import type { PlaystoreConfig } from "../src/config.js";
import { classifyReviewText, formatReviewText } from "../src/domain/reviewSignals.js";
import type { PlayRelease, PlayReview } from "../src/schemas/playApiTypes.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("review keyword classification", () => {
  it("classifies crash, freeze, and ANR wording without depending on reviewer language metadata", () => {
    expect(classifyReviewText(["SIGSEGV on startup"]).signals).toContain("crash");
    expect(classifyReviewText(["ANR every time I open settings"]).signals).toContain("anr");
    expect(classifyReviewText(["La pantalla se congela despues de actualizar"]).signals).toContain("freeze");
  });
});

describe("review text redaction", () => {
  it("omits review text in the default redacted mode", () => {
    expect(formatReviewText("Crashes on launch. Email me at user@example.com.", "redacted")).toEqual({
      mode: "redacted",
      included: false,
      piiRedacted: false,
      truncated: false
    });
  });

  it("redacts contact-like tokens before returning snippets", () => {
    const output = formatReviewText(
      "Crash after login. Contact user@example.com or +1 555 123 4567 at https://example.com/support please.",
      "snippet",
      60
    );

    expect(output).toMatchObject({
      mode: "snippet",
      included: true,
      piiRedacted: true,
      truncated: true
    });
    expect(output.value).toContain("[email]");
    expect(output.value).toContain("[number]");
    expect(output.value).toContain("[url]");
    expect(output.value).not.toContain("user@example.com");
    expect(output.value).not.toContain("555 123 4567");
    expect(output.value).not.toContain("https://example.com");
  });
});

describe("reviews recent", () => {
  it("filters by date, version code, and rating while keeping review text redacted by default", async () => {
    const client = mockPublisherClient({
      reviews: [
        review("crash-123", {
          text: "Crashes on launch. Contact user@example.com.",
          modified: "2026-06-20T12:00:00Z",
          rating: 1,
          versionCode: "123",
          versionName: "1.2.3"
        }),
        review("freeze-124", {
          text: "Freezes after checkout.",
          modified: "2026-06-20T13:00:00Z",
          rating: 1,
          versionCode: "124"
        }),
        review("high-rating-123", {
          text: "Crash is fixed now.",
          modified: "2026-06-20T14:00:00Z",
          rating: 5,
          versionCode: "123"
        }),
        review("old-123", {
          text: "Crashes before the requested window.",
          modified: "2026-06-01T12:00:00Z",
          rating: 1,
          versionCode: "123"
        }),
        {
          reviewId: "developer-only",
          comments: [{ developerComment: { text: "Thanks", lastModified: timestamp("2026-06-20T15:00:00Z") } }]
        }
      ],
      releases: [
        {
          name: "1.2.3 production",
          versionCodes: ["123"],
          status: "completed",
          userFraction: 1
        },
        {
          name: "1.2.4 production",
          versionCodes: ["124"],
          status: "inProgress",
          userFraction: 0.25
        }
      ]
    });

    const output = await getRecentReviews(
      {
        packageName: undefined,
        track: "production",
        versionCodes: ["123"],
        ratings: [],
        minRating: undefined,
        maxRating: 2,
        startDate: "2026-06-17",
        endDateExclusive: "2026-06-24",
        limit: 10,
        fetchLimit: 20,
        translationLanguage: undefined,
        reviewText: "redacted",
        format: "json"
      },
      { config, client }
    );

    expect(client.listReviews).toHaveBeenCalledWith("com.example.app", {
      token: undefined,
      maxResults: 20,
      translationLanguage: undefined
    });
    expect(output.summary).toMatchObject({
      fetchedReviewCount: 5,
      matchedReviewCount: 1,
      returnedReviewCount: 1,
      signalReviewCount: 1,
      crashCount: 1,
      lowRatingSignalReviewCount: 1
    });
    expect(output.reviews).toEqual([
      expect.objectContaining({
        reviewId: "crash-123",
        versionCode: "123",
        versionName: "1.2.3",
        starRating: 1,
        signals: expect.objectContaining({
          crash: true
        }),
        text: {
          mode: "redacted",
          included: false,
          piiRedacted: false,
          truncated: false
        }
      })
    ]);
    expect(output.summary.versionBreakdown).toEqual([
      expect.objectContaining({
        versionCode: "123",
        releaseName: "1.2.3 production",
        status: "completed",
        rolloutFraction: 1,
        reviewCount: 1,
        signalReviewCount: 1
      })
    ]);
    expect(output.releaseContext.matchedReleases).toEqual([
      expect.objectContaining({
        releaseName: "1.2.3 production",
        versionCodes: ["123"]
      })
    ]);
    expect(JSON.stringify(output)).not.toContain("Crashes on launch");
    expect(JSON.stringify(output)).not.toContain("user@example.com");
    expect(output.warnings.join("\n")).toContain("Review text is redacted by default");
  });
});

function mockPublisherClient(fixtures: { reviews: PlayReview[]; releases: PlayRelease[] }): PlayPublisherClient {
  return {
    listTracks: vi.fn(),
    getTrack: vi.fn(),
    listReleases: vi.fn(async () => fixtures.releases),
    listReviews: vi.fn(async () => ({ reviews: fixtures.reviews }))
  };
}

function review(
  reviewId: string,
  options: {
    text: string;
    modified: string;
    rating: number;
    versionCode?: string;
    versionName?: string;
  }
): PlayReview {
  return {
    reviewId,
    authorName: "Private reviewer",
    comments: [
      {
        userComment: {
          text: options.text,
          lastModified: timestamp(options.modified),
          starRating: options.rating,
          reviewerLanguage: undefined,
          appVersionCode: options.versionCode,
          appVersionName: options.versionName,
          androidOsVersion: 35,
          thumbsUpCount: 0,
          thumbsDownCount: 0
        }
      }
    ]
  };
}

function timestamp(iso: string): { seconds: string } {
  return {
    seconds: String(Math.floor(Date.parse(iso) / 1000))
  };
}
