# Play Store Codex Plugin

Read-only Codex workflows and a local TypeScript CLI for investigating Google Play release health, crash and ANR issues, review signals, rollout risk, and local stack traces.

Use it through the bundled Codex skills or directly from the terminal with `scripts/playstore`. It never pauses rollouts, promotes releases, edits tracks, responds to reviews, or performs any other Play Console mutation.

## Capabilities

- Validate local setup without contacting Google APIs.
- Discover allowlisted apps and releases.
- Summarize crash and ANR health for release version codes.
- Rank Play crash and ANR issues and fetch representative reports.
- Compare a current release with a previous release.
- List Play Developer Reporting anomalies.
- Correlate low-rating review signals while redacting review text by default.
- Generate a read-only rollout-risk decision aid.
- Map stack traces to a local Android source tree.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex plugin manifest. |
| `skills/` | Codex skill instructions for release-health and crash-triage workflows. |
| `scripts/playstore` | Stable wrapper for the built CLI. |
| `cli/` | TypeScript CLI source, tests, and package metadata. |
| `docs/` | Setup, permissions, validation, troubleshooting, and architecture notes. |
| `examples/` | Example prompts and mocked API fixtures for tests and demos. |

## Requirements

- Node.js 20 or newer.
- npm.
- Python 3 for plugin manifest validation.
- A Google identity with access to the target Play Console account when running API-backed commands.
- A package allowlist before any command can access Play data.

## Install And Build

From a fresh checkout:

```bash
cd cli
npm install
npm run build
npm test
cd ..
scripts/playstore doctor --format markdown
```

`scripts/playstore` runs `cli/dist/index.js`, so rebuild after TypeScript changes.

## Configure Play Access

The CLI automatically reads `.env` from the plugin root, then overlays any variables already set in the shell. Use `.env.example` as the template for local values, or keep exporting variables in your terminal for one-off overrides.

Choose one credential source:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account.json"
```

Or use application-default credentials:

```bash
export GOOGLE_AUTH_USE_ADC=true
```

Then restrict which packages this read-only CLI may inspect:

```bash
export PLAYSTORE_PACKAGE_ALLOWLIST="com.example.app,com.example.beta"
export PLAYSTORE_DEFAULT_PACKAGE="com.example.app"
```

`PLAYSTORE_DEFAULT_PACKAGE` is optional, but when set it must also appear in `PLAYSTORE_PACKAGE_ALLOWLIST`.

Equivalent plugin-root `.env` example:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
# GOOGLE_AUTH_USE_ADC=true
PLAYSTORE_PACKAGE_ALLOWLIST=com.example.app,com.example.beta
PLAYSTORE_DEFAULT_PACKAGE=com.example.app
```

## Common Commands

Use absolute date windows. `--end-date` is exclusive.

```bash
scripts/playstore doctor --format json
scripts/playstore apps list --format json
scripts/playstore releases list --package com.example.app --track production --latest --format json
scripts/playstore health release --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
scripts/playstore issues list --package com.example.app --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --type all --state all --format json
scripts/playstore reports list --package com.example.app --issue-id ISSUE_ID --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
scripts/playstore anomalies list --package com.example.app --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format json
scripts/playstore reviews recent --package com.example.app --track production --version-code 123 --days 7 --end-date 2026-06-08 --max-rating 2 --format markdown
scripts/playstore compare releases --package com.example.app --track production --current 123 --previous 122 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
scripts/playstore report rollout-risk --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
scripts/playstore triage stacktrace --file crash.txt --source-root /path/to/android/app --format markdown
```

`doctor` and `triage stacktrace` are local-only. The other commands are read-only Google API clients.

## Codex Installation

Install the plugin from a local Codex marketplace entry that points at this checkout.

For routine local development:

1. Keep this checkout as the plugin source referenced by your local marketplace.
2. Run `npm run build` and `npm test` from `cli/`.
3. Run `scripts/playstore doctor --format json`.
4. Run the validation commands in [docs/validation.md](docs/validation.md).
5. Reinstall the plugin from the configured marketplace with `codex plugin add playstore-plugin@<marketplace-name>`.
6. Start a new Codex thread so updated skills and metadata are loaded.

See [docs/setup.md](docs/setup.md) for the full install path and [docs/troubleshooting.md](docs/troubleshooting.md) for common failures.

## Example Prompts And Fixtures

- [examples/prompts.md](examples/prompts.md) contains ready-to-use Codex prompts for release health, crash triage, review correlation, and rollout-risk checks.
- [examples/fixtures](examples/fixtures) contains mocked Play Publisher and Play Developer Reporting API responses. The data is fake and safe for tests, demos, and parser development.

## Architecture

See [docs/architecture.md](docs/architecture.md) for component notes, data boundaries, and read-only guarantees.

## License

MIT. See [LICENSE](LICENSE).
