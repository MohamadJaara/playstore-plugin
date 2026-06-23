import { PlaystoreCliError, type PlaystoreErrorCode } from "../utils/errors.js";

export interface GooglePlayRequestOptions {
  method: "GET" | "POST";
  url: string;
  data?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface GooglePlayRequestClient {
  request<TResponse>(options: GooglePlayRequestOptions): Promise<GooglePlayResponse<TResponse>>;
}

interface GooglePlayResponse<TResponse> {
  data: TResponse;
  status?: number;
}

interface GoogleApiErrorBody {
  error?: {
    code?: number;
    status?: unknown;
    message?: string;
  };
}

const SAFE_API_STATUSES = new Set([
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED"
]);

export async function requestGooglePlay<TResponse>(
  client: GooglePlayRequestClient,
  options: GooglePlayRequestOptions
): Promise<TResponse> {
  try {
    const response = await client.request<TResponse>(options);
    return response.data;
  } catch (error) {
    throw normalizeGooglePlayError(error);
  }
}

export function normalizeGooglePlayError(error: unknown): PlaystoreCliError {
  const status = responseStatus(error);
  const apiStatus = responseApiStatus(error);
  const code = errorCodeForStatus(status);
  const label = status ? `Google Play API request failed with HTTP ${status}.` : "Google Play API request failed.";
  const apiReason = apiStatus ? ` API status: ${apiStatus}.` : "";

  return new PlaystoreCliError(code, `${label}${apiReason}`, hintForCode(code));
}

function responseStatus(error: unknown): number | undefined {
  if (!isObject(error)) {
    return undefined;
  }

  const response = error.response;
  if (!isObject(response)) {
    return undefined;
  }

  return typeof response.status === "number" ? response.status : undefined;
}

function responseApiStatus(error: unknown): string | undefined {
  if (!isObject(error)) {
    return undefined;
  }

  const response = error.response;
  if (!isObject(response)) {
    return undefined;
  }

  const data = response.data;
  if (!isGoogleApiErrorBody(data)) {
    return undefined;
  }

  const apiStatus = data.error?.status;

  if (typeof apiStatus !== "string" || !SAFE_API_STATUSES.has(apiStatus)) {
    return undefined;
  }

  return apiStatus;
}

function errorCodeForStatus(status: number | undefined): PlaystoreErrorCode {
  if (status === 403 || status === 401) {
    return "API_PERMISSION_DENIED";
  }

  if (status === 404) {
    return "API_NOT_FOUND";
  }

  if (status === 429) {
    return "API_RATE_LIMITED";
  }

  if (status && status >= 500) {
    return "API_UNAVAILABLE";
  }

  return "API_REQUEST_FAILED";
}

function hintForCode(code: PlaystoreErrorCode): string {
  switch (code) {
    case "API_PERMISSION_DENIED":
      return "Verify the credential has read access to this Play Console app and API.";
    case "API_NOT_FOUND":
      return "Verify the package name, Play Console resource, and API availability.";
    case "API_RATE_LIMITED":
      return "Retry later or reduce request volume; the failed request was read-only.";
    case "API_UNAVAILABLE":
      return "Retry later; Google Play returned a transient server-side failure.";
    default:
      return "Run with validated credentials and package allowlist, then retry the read-only request.";
  }
}

function isGoogleApiErrorBody(value: unknown): value is GoogleApiErrorBody {
  return isObject(value) && (!("error" in value) || isObject(value.error));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
