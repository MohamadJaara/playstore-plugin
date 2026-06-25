export type PlaystoreErrorCode =
  | "MISSING_CREDENTIALS"
  | "MISSING_PACKAGE_ALLOWLIST"
  | "PACKAGE_NOT_ALLOWED"
  | "INVALID_CONFIG"
  | "INVALID_DOTENV"
  | "API_AUTH_FAILED"
  | "API_PERMISSION_DENIED"
  | "API_NOT_FOUND"
  | "API_RATE_LIMITED"
  | "API_UNAVAILABLE"
  | "API_REQUEST_FAILED";

export class PlaystoreCliError extends Error {
  readonly code: PlaystoreErrorCode;
  readonly hint: string;

  constructor(code: PlaystoreErrorCode, message: string, hint: string) {
    super(message);
    this.name = "PlaystoreCliError";
    this.code = code;
    this.hint = hint;
  }
}

export function isPlaystoreCliError(error: unknown): error is PlaystoreCliError {
  return error instanceof PlaystoreCliError;
}

export function formatCliError(error: unknown): string {
  if (isPlaystoreCliError(error)) {
    return `${error.code}: ${error.message}\nHint: ${error.hint}`;
  }

  return error instanceof Error ? error.message : String(error);
}
