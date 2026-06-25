# Setup

The Play Store Codex plugin is a local Codex plugin plus a TypeScript CLI named `playstore`. The CLI is read-only and is invoked through `scripts/playstore` from the repository root.

## Requirements

- Node.js 20 or newer.
- npm.
- Python 3 for plugin manifest validation.
- A Google identity with access to the relevant Play Console account for API-backed commands.
- A configured package allowlist before any command can access Play data.

## Build The CLI

From a fresh checkout:

```bash
cd cli
npm install
npm run build
npm test
cd ..
```

The wrapper at `scripts/playstore` expects `cli/dist/index.js`, so run `npm run build` after TypeScript changes.

Run local diagnostics:

```bash
scripts/playstore doctor --format markdown
```

`doctor` checks local files, Node.js, credential configuration, and allowlist configuration. It does not contact Google APIs.

## Configure Credentials

The CLI reads `.env` from the plugin root automatically. Values already present in the shell take precedence, so temporary command-line overrides still work.

Set exactly one credential path for normal use.

Use a service-account file:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/service-account.json"
```

Or opt in to application-default credentials:

```bash
export GOOGLE_AUTH_USE_ADC=true
```

Then restrict the packages this CLI may inspect:

```bash
export PLAYSTORE_PACKAGE_ALLOWLIST="com.example.app,com.example.beta"
```

Optionally set a default package:

```bash
export PLAYSTORE_DEFAULT_PACKAGE="com.example.app"
```

`PLAYSTORE_DEFAULT_PACKAGE` must also appear in `PLAYSTORE_PACKAGE_ALLOWLIST`.

The same configuration can live in a plugin-root `.env`:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
# GOOGLE_AUTH_USE_ADC=true
PLAYSTORE_PACKAGE_ALLOWLIST=com.example.app,com.example.beta
PLAYSTORE_DEFAULT_PACKAGE=com.example.app
```

## Install In Codex

Install this plugin through a local Codex marketplace entry that points at the plugin source. If your marketplace is already configured, reinstall after local edits:

```bash
codex plugin add playstore-plugin@<marketplace-name>
```

For the default personal marketplace workflow, place this checkout at `~/plugins/playstore-plugin` or symlink that path to this checkout. Then ensure `~/.agents/plugins/marketplace.json` has an entry like:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "playstore-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/playstore-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

For a non-default local marketplace, register the marketplace root first:

```bash
codex plugin marketplace add /absolute/path/to/marketplace-root
codex plugin add playstore-plugin@<marketplace-name>
```

After reinstalling, start a new Codex thread. Skills and plugin metadata are loaded when a thread starts.

## First API Check

After credentials and allowlist are configured:

```bash
scripts/playstore apps list --format json
scripts/playstore releases list --package com.example.app --track production --latest --format json
```

If these pass, run a narrow health command with an absolute date window:

```bash
scripts/playstore health release --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
```

`--end-date` is exclusive.

## Privacy Checks

The CLI should never print credential JSON, access tokens, refresh tokens, or service-account file contents. Review text is redacted by default. Raw Play API responses and fetched crash reports should not be committed.
