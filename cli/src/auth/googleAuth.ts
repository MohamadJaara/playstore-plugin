import { GoogleAuth } from "google-auth-library";

import type { PlaystoreConfig } from "../config.js";
import type { GooglePlayRequestClient } from "../clients/request.js";
import { PlaystoreCliError } from "../utils/errors.js";

const GOOGLE_PLAY_SCOPES = [
  "https://www.googleapis.com/auth/playdeveloperreporting",
  "https://www.googleapis.com/auth/androidpublisher"
];

export function createGoogleAuth(config: PlaystoreConfig): GoogleAuth {
  if (!config.credentialsFile && !config.useApplicationDefaultCredentials) {
    throw new PlaystoreCliError(
      "MISSING_CREDENTIALS",
      "No Google credentials are configured.",
      "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_AUTH_USE_ADC=true before creating an authenticated client."
    );
  }

  return new GoogleAuth({
    keyFile: config.credentialsFile,
    scopes: GOOGLE_PLAY_SCOPES
  });
}

export async function createAuthenticatedClient(config: PlaystoreConfig): Promise<GooglePlayRequestClient> {
  try {
    return (await createGoogleAuth(config).getClient()) as GooglePlayRequestClient;
  } catch {
    throw new PlaystoreCliError(
      "API_AUTH_FAILED",
      "Google authentication failed.",
      "Verify the configured credential has access to the requested Play Console account. Secret values are intentionally not included in this error."
    );
  }
}
