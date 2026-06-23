import type { PlayRelease } from "../schemas/playApiTypes.js";
import { releaseSummarySchema, type ReleaseSummary } from "../schemas/cliOutputs.js";

const RELEASE_STATUS_ORDER = ["completed", "inProgress", "draft", "halted"] as const;

export function summarizeRelease(packageName: string, track: string, release: PlayRelease): ReleaseSummary {
  return releaseSummarySchema.parse({
    packageName,
    track,
    versionCodes: release.versionCodes,
    ...(release.name ? { releaseName: release.name } : {}),
    ...(release.status ? { status: release.status } : {}),
    ...(release.userFraction === undefined ? {} : { rolloutFraction: release.userFraction })
  });
}

export function selectLatestRelease(releases: ReleaseSummary[]): ReleaseSummary | undefined {
  const candidates = releases.filter((release) => release.versionCodes.length > 0);

  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort(compareReleaseNewestFirst)[0];
}

function compareReleaseNewestFirst(left: ReleaseSummary, right: ReleaseSummary): number {
  const versionDelta = maxVersionCode(right) - maxVersionCode(left);

  if (versionDelta !== 0) {
    return versionDelta;
  }

  return statusRank(left.status) - statusRank(right.status);
}

function maxVersionCode(release: ReleaseSummary): number {
  return Math.max(...release.versionCodes.map((versionCode) => Number.parseInt(versionCode, 10)).filter(Number.isFinite));
}

function statusRank(status: string | undefined): number {
  const index = RELEASE_STATUS_ORDER.indexOf(status as (typeof RELEASE_STATUS_ORDER)[number]);
  return index === -1 ? RELEASE_STATUS_ORDER.length : index;
}
