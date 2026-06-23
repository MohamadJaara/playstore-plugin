import type { PlayRelease, PlayReview, PlayReviewPage, PlayTrack } from "../schemas/playApiTypes.js";
import { requestGooglePlay, type GooglePlayRequestClient } from "./request.js";

const PUBLISHER_BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3";

interface PublisherTrackResponse {
  track?: string;
  releases?: Array<{
    name?: string;
    versionCodes?: string[];
    status?: string;
    userFraction?: number;
    releaseNotes?: Array<{
      language?: string;
      text?: string;
    }>;
  }>;
}

interface PublisherReleaseSummaryResponse {
  releaseName?: string;
  track?: string;
  activeArtifacts?: Array<{
    versionCode?: number | string;
  }>;
  releaseLifecycleState?: string;
  userFraction?: number;
}

interface PublisherTracksResponse {
  tracks?: PublisherTrackResponse[];
}

interface PublisherReleasesResponse {
  releases?: PublisherReleaseSummaryResponse[];
}

interface PublisherReviewsResponse {
  reviews?: Array<{
    reviewId?: string;
    authorName?: string;
    comments?: Array<{
      userComment?: {
        text?: string;
        originalText?: string;
        lastModified?: {
          seconds?: string;
          nanos?: number;
        };
        starRating?: number;
        reviewerLanguage?: string;
        device?: string;
        androidOsVersion?: number;
        appVersionCode?: number | string;
        appVersionName?: string;
        thumbsUpCount?: number;
        thumbsDownCount?: number;
        deviceMetadata?: {
          productName?: string;
          manufacturer?: string;
          deviceClass?: string;
          screenWidthPx?: number;
          screenHeightPx?: number;
          nativePlatform?: string;
          screenDensityDpi?: number;
          glEsVersion?: number;
          cpuModel?: string;
          cpuMake?: string;
          ramMb?: number;
        };
      };
      developerComment?: {
        text?: string;
        lastModified?: {
          seconds?: string;
          nanos?: number;
        };
      };
    }>;
  }>;
  tokenPagination?: {
    nextPageToken?: string;
  };
}

export interface ListReviewsOptions {
  token?: string;
  maxResults?: number;
  translationLanguage?: string;
}

export interface PlayPublisherClient {
  listTracks(packageName: string, editId: string): Promise<PlayTrack[]>;
  getTrack(packageName: string, editId: string, track: string): Promise<PlayTrack>;
  listReleases(packageName: string, track: string): Promise<PlayRelease[]>;
  listReviews(packageName: string, options?: ListReviewsOptions): Promise<PlayReviewPage>;
}

export function createPlayPublisherClient(requestClient: GooglePlayRequestClient): PlayPublisherClient {
  return {
    async listTracks(packageName: string, editId: string): Promise<PlayTrack[]> {
      const response = await requestGooglePlay<PublisherTracksResponse>(requestClient, {
        method: "GET",
        url: `${PUBLISHER_BASE_URL}/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(
          editId
        )}/tracks`
      });

      return (response.tracks ?? []).map(normalizeTrack);
    },

    async getTrack(packageName: string, editId: string, track: string): Promise<PlayTrack> {
      const response = await requestGooglePlay<PublisherTrackResponse>(requestClient, {
        method: "GET",
        url: `${PUBLISHER_BASE_URL}/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(
          editId
        )}/tracks/${encodeURIComponent(track)}`
      });

      return normalizeTrack(response);
    },

    async listReleases(packageName: string, track: string): Promise<PlayRelease[]> {
      const response = await requestGooglePlay<PublisherReleasesResponse>(requestClient, {
        method: "GET",
        url: `${PUBLISHER_BASE_URL}/applications/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(
          track
        )}/releases`
      });

      return normalizeReleaseSummaries(response.releases);
    },

    async listReviews(packageName: string, options: ListReviewsOptions = {}): Promise<PlayReviewPage> {
      const response = await requestGooglePlay<PublisherReviewsResponse>(requestClient, {
        method: "GET",
        url: `${PUBLISHER_BASE_URL}/applications/${encodeURIComponent(packageName)}/reviews`,
        params: compactParams({
          token: options.token,
          maxResults: options.maxResults,
          translationLanguage: options.translationLanguage
        })
      });

      return {
        reviews: normalizeReviews(response.reviews),
        nextPageToken: response.tokenPagination?.nextPageToken
      };
    }
  };
}

function normalizeTrack(track: PublisherTrackResponse): PlayTrack {
  return {
    track: track.track ?? "",
    releases: normalizeReleases(track.releases)
  };
}

function normalizeReleases(releases: PublisherTrackResponse["releases"]): PlayRelease[] {
  return (releases ?? []).map((release) => ({
    name: release.name,
    versionCodes: release.versionCodes ?? [],
    status: release.status,
    userFraction: release.userFraction,
    releaseNotes: (release.releaseNotes ?? [])
      .filter((note) => note.language && note.text)
      .map((note) => ({
        language: note.language as string,
        text: note.text as string
      }))
  }));
}

function normalizeReleaseSummaries(releases: PublisherReleaseSummaryResponse[] | undefined): PlayRelease[] {
  return (releases ?? []).map((release) => ({
    name: release.releaseName,
    versionCodes: (release.activeArtifacts ?? [])
      .map((artifact) => artifact.versionCode)
      .filter((versionCode): versionCode is number | string => versionCode !== undefined && versionCode !== "")
      .map((versionCode) => String(versionCode)),
    status: release.releaseLifecycleState,
    userFraction: release.userFraction,
    releaseNotes: []
  }));
}

function normalizeReviews(reviews: PublisherReviewsResponse["reviews"]): PlayReview[] {
  return (reviews ?? [])
    .filter((review) => review.reviewId)
    .map((review) => ({
      reviewId: review.reviewId as string,
      authorName: review.authorName,
      comments: (review.comments ?? []).map((comment) => ({
        userComment: comment.userComment
          ? {
              ...comment.userComment,
              appVersionCode:
                comment.userComment.appVersionCode === undefined || comment.userComment.appVersionCode === ""
                  ? undefined
                  : String(comment.userComment.appVersionCode)
            }
          : undefined,
        developerComment: comment.developerComment
      }))
    }));
}

function compactParams<TValue extends string | number | boolean>(
  record: Record<string, TValue | undefined>
): Record<string, TValue> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, TValue] => entry[1] !== undefined));
}
