# Validation

Use these commands from a clean checkout before review, release, or local plugin reinstall.

## Full Local Validation

```bash
cd cli
npm install
npm run build
npm test
cd ..
scripts/playstore doctor --format json
python3 scripts/validate-plugin-manifest.py
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

Expected results:

- `npm run build` compiles the TypeScript CLI into `cli/dist/`.
- `npm test` runs all Vitest tests, including mocked fixture validation.
- `scripts/playstore doctor --format json` prints a report with `"ok": true` when local files, Node.js, credentials, allowlist, and default package checks have no failures.
- `python3 scripts/validate-plugin-manifest.py` runs the repo-local CI manifest checks.
- The plugin validator prints `Plugin validation passed`.

`doctor` performs local checks only and does not contact Google APIs.

## Plugin Validation Command

The installed `codex plugin` CLI currently has add, list, marketplace, and remove subcommands, but no `codex plugin validate` subcommand. Use the bundled plugin-creator validator:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

The validator checks `.codex-plugin/plugin.json`, required manifest fields, semver, supported paths, missing referenced assets, and leftover `[TODO: ...]` placeholders.

CI also runs `python3 scripts/validate-plugin-manifest.py`, a smaller repo-local check that does not require a local Codex installation.

## Fixture JSON Validation

The test suite parses every JSON file under `examples/fixtures/`. A quick manual check is:

```bash
find examples/fixtures -name "*.json" -exec python3 -m json.tool {} \; >/dev/null
```

Fixture files must remain fake, sanitized, and safe to commit.

## API Smoke Checks

After credentials and package allowlist are configured, these commands verify read-only API access:

```bash
scripts/playstore apps list --format json
scripts/playstore releases list --package com.example.app --track production --latest --format json
```

Then run a narrow release-health query:

```bash
scripts/playstore health release --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format json
```

Use a real package and version code from your allowlist. `--end-date` is exclusive.

## Before Updating Codex

When validating a local plugin update for Codex:

1. Run the full local validation.
2. Reinstall from the configured local marketplace with `codex plugin add playstore-plugin@<marketplace-name>`.
3. Start a new Codex thread so updated skills and metadata are loaded.
