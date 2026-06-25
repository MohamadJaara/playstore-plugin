# Troubleshooting

Use `scripts/playstore doctor --format markdown` first. It performs local checks only and is safe to run without contacting Google APIs.

## CLI Not Built

Symptom:

```text
playstore CLI has not been built yet.
```

Fix:

```bash
cd cli
npm run build
cd ..
```

## Node.js Is Too Old

The CLI requires Node.js 20 or newer. `doctor` reports a failing Node.js check when the runtime is too old.

Fix by installing a supported Node.js version, then rerun:

```bash
node --version
scripts/playstore doctor --format json
```

## Missing Credentials

Symptom:

```text
MISSING_CREDENTIALS
```

Fix by setting one credential source in plugin-root `.env` or in the shell:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account.json"
```

Or:

```bash
export GOOGLE_AUTH_USE_ADC=true
```

`doctor` does not verify the Google account over the network; it only checks local configuration.

## Missing Allowlist

Symptom:

```text
MISSING_PACKAGE_ALLOWLIST
```

Fix by setting the allowlist in plugin-root `.env` or in the shell:

```bash
export PLAYSTORE_PACKAGE_ALLOWLIST="com.example.app"
```

Every API-backed command validates the package before contacting Google APIs.

## Package Not Allowed

Symptom:

```text
PACKAGE_NOT_ALLOWED
```

Fix by adding the package to the allowlist:

```bash
export PLAYSTORE_PACKAGE_ALLOWLIST="com.example.app,com.example.beta"
```

If `PLAYSTORE_DEFAULT_PACKAGE` is set, it must also appear in the allowlist.

## Google API Permission Errors

Typical errors:

- `API_AUTH_FAILED`
- `API_PERMISSION_DENIED`
- `API_NOT_FOUND`

Checks:

- Confirm the credential has access to the Play Console account.
- Confirm the package name is correct and allowlisted.
- Confirm the requested release, issue, or report exists for the selected package.
- Confirm the Google Play Developer Reporting API and Android Publisher access are enabled for the account.

The CLI normalizes API failures and should not print raw request URLs, tokens, or response bodies.

## Rate Limits Or Temporary API Failures

Typical errors:

- `API_RATE_LIMITED`
- `API_UNAVAILABLE`
- `API_REQUEST_FAILED`

Fix by retrying later, reducing request limits, narrowing date windows, or avoiding repeated broad queries.

## No Data Returned

Empty results do not always mean a release is healthy. Common causes:

- Wrong version code.
- Date window outside Play reporting availability.
- `--end-date` treated as inclusive instead of exclusive.
- Very recent release with incomplete vitals.
- Filters that remove matching rows.
- Play API lag.

Check warnings in JSON or Markdown output before drawing conclusions.

## Review Text Privacy

`reviews recent` redacts review text by default. If `--review-text snippet` or `--review-text full` is explicitly used, URL, email, phone-like, and long numeric tokens are still redacted before output.

Do not commit raw review exports or fetched API responses.

## Stack Trace Triage Has No Matches

Local stack-trace triage can fail to map frames when:

- The stack trace is obfuscated.
- Source roots point at the wrong checkout.
- Java or Kotlin source files are generated or missing.
- Native frames dominate the trace.
- Line numbers are missing or stale.

Treat source matches as investigation starting points, not proof of causation.

## Plugin Changes Do Not Appear In Codex

After manifest or skill edits:

1. Run plugin validation.
2. Reinstall from the configured marketplace:

```bash
codex plugin add playstore-plugin@<marketplace-name>
```

3. Start a new Codex thread.

Codex loads plugin metadata and skills at thread startup.
