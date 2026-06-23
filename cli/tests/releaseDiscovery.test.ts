import { describe, expect, it, vi } from "vitest";

import { listReleases } from "../src/commands/releases.js";
import { selectLatestRelease, summarizeRelease } from "../src/domain/releases.js";
import { appsListOutputSchema, releasesListOutputSchema } from "../src/schemas/cliOutputs.js";
import type { PlayPublisherClient } from "../src/clients/playPublisherClient.js";
import type { PlaystoreConfig } from "../src/config.js";

const config: PlaystoreConfig = {
  useApplicationDefaultCredentials: true,
  defaultPackage: "com.example.app",
  packageAllowlist: ["com.example.app"]
};

describe("release discovery output schemas", () => {
  it("validates app list output", () => {
    expect(
      appsListOutputSchema.parse({
        apps: [{ packageName: "com.example.app" }]
      })
    ).toEqual({
      apps: [{ packageName: "com.example.app" }]
    });
  });

  it("validates release list output with rollout fraction when available", () => {
    expect(
      releasesListOutputSchema.parse({
        packageName: "com.example.app",
        track: "production",
        releases: [
          {
            packageName: "com.example.app",
            track: "production",
            versionCodes: ["123"],
            releaseName: "1.2.3",
            status: "inProgress",
            rolloutFraction: 0.25
          }
        ]
      })
    ).toMatchObject({
      releases: [{ rolloutFraction: 0.25 }]
    });
  });
});

describe("selectLatestRelease", () => {
  it("returns undefined for empty tracks", () => {
    expect(selectLatestRelease([])).toBeUndefined();
  });

  it("selects the highest version code across multiple releases", () => {
    const releases = [
      summarizeRelease("com.example.app", "production", {
        name: "older",
        versionCodes: ["100", "101"],
        status: "completed"
      }),
      summarizeRelease("com.example.app", "production", {
        name: "newer",
        versionCodes: ["102"],
        status: "draft"
      })
    ];

    expect(selectLatestRelease(releases)).toMatchObject({
      releaseName: "newer",
      versionCodes: ["102"]
    });
  });

  it("ignores releases with missing version codes", () => {
    const releases = [
      summarizeRelease("com.example.app", "beta", {
        name: "metadata-only",
        versionCodes: [],
        status: "completed"
      }),
      summarizeRelease("com.example.app", "beta", {
        name: "with-version",
        versionCodes: ["200"],
        status: "completed"
      })
    ];

    expect(selectLatestRelease(releases)).toMatchObject({
      releaseName: "with-version"
    });
  });
});

describe("listReleases", () => {
  it("passes package and track filters to the Play Publisher client", async () => {
    const client = mockPublisherClient([
      {
        name: "internal-456",
        versionCodes: ["456"],
        status: "completed"
      }
    ]);

    await expect(
      listReleases(
        {
          packageName: undefined,
          track: "internal",
          latest: true,
          format: "json"
        },
        { config, client }
      )
    ).resolves.toEqual({
      packageName: "com.example.app",
      track: "internal",
      releases: [
        {
          packageName: "com.example.app",
          track: "internal",
          versionCodes: ["456"],
          releaseName: "internal-456",
          status: "completed"
        }
      ],
      latest: {
        packageName: "com.example.app",
        track: "internal",
        versionCodes: ["456"],
        releaseName: "internal-456",
        status: "completed"
      }
    });
    expect(client.listReleases).toHaveBeenCalledWith("com.example.app", "internal");
  });

  it("returns an empty release list and no latest release for empty tracks", async () => {
    await expect(
      listReleases(
        {
          packageName: "com.example.app",
          track: "beta",
          latest: true,
          format: "json"
        },
        { config, client: mockPublisherClient([]) }
      )
    ).resolves.toEqual({
      packageName: "com.example.app",
      track: "beta",
      releases: []
    });
  });
});

function mockPublisherClient(releases: Awaited<ReturnType<PlayPublisherClient["listReleases"]>>): PlayPublisherClient {
  return {
    listTracks: vi.fn(),
    getTrack: vi.fn(),
    listReleases: vi.fn(async () => releases),
    listReviews: vi.fn()
  };
}
