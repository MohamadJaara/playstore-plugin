# Permissions

This plugin is read-only. It must not pause rollouts, promote releases, edit tracks, respond to reviews, or perform any other Google Play mutation.

## Google Access

API commands use Google credentials from one of these sources:

- `GOOGLE_APPLICATION_CREDENTIALS`, pointing to a service-account JSON file.
- Application-default credentials when `GOOGLE_AUTH_USE_ADC=true`.

The auth helper configures scopes for Google Play Developer Reporting data and Android Publisher data used by read-only commands. Command code must still avoid write or mutation endpoints.

## Package Restrictions

`PLAYSTORE_PACKAGE_ALLOWLIST` is required for commands that access Play data. It is a comma-separated list of package names the CLI may inspect.

Package validation happens before API calls. If a package name is not in the allowlist, the command fails with `PACKAGE_NOT_ALLOWED`.

`PLAYSTORE_DEFAULT_PACKAGE` is optional. If set, it must also appear in `PLAYSTORE_PACKAGE_ALLOWLIST`.

## Local-Only Commands

These commands do not contact Google APIs:

- `scripts/playstore doctor`
- `scripts/playstore triage stacktrace`

`triage stacktrace` reads the provided stack trace and local Android source tree only.

## Secret And Data Handling

- Do not commit credentials.
- Do not commit fetched Play API responses, raw reports, review text, or stack traces unless the user explicitly asks for a sanitized fixture.
- Do not log credential file contents, access tokens, refresh tokens, or service-account file paths.
- `playstore doctor` may report whether credentials appear configured, but it must not print secret values.
- Review text is redacted by default. `--review-text snippet` and `--review-text full` still redact URL, email, phone-like, and long numeric tokens before output.

## Rollout Decisions

`scripts/playstore report rollout-risk` produces an inferred decision aid from measured facts. Recommendation categories are:

- `continue monitoring`
- `investigate before increasing rollout`
- `manually halt rollout outside the plugin`

All rollout changes remain manual Play Console decisions by a human release owner.
