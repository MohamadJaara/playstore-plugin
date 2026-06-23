---
name: play-store-release-health
description: Investigate Google Play release health with the repo-local read-only Play Store CLI. Use when asked to check Android release vitals, compare a current release with a previous release, find crash or ANR regressions, assess rollout health, or prepare a release-health investigation summary from Play Console data.
---

# Play Store Release Health

## Overview

Use this skill to guide a release-health investigation through `scripts/playstore`. Prefer JSON output while reasoning, then use Markdown output when the user wants a readable report.

The CLI is read-only. It may fetch Play Console data, but it must not pause, promote, edit, halt, or otherwise mutate releases. Any rollout decision is a manual Play Console decision for a human release owner.

## Before Running Commands

- Run from the plugin repository root so `scripts/playstore` resolves correctly.
- Start with `scripts/playstore doctor --format json` when setup is uncertain. `doctor` performs local checks only and does not contact Google APIs.
- Use `scripts/playstore apps list --format json` to inspect the configured `PLAYSTORE_PACKAGE_ALLOWLIST` when the package is missing or ambiguous.
- Use absolute dates. `--end-date` is exclusive, and Play vitals output uses the `America/Los_Angeles` reporting timezone.
- Keep fetched Play data out of commits and persistent logs unless the user explicitly asks for an artifact.

## Command Reference

Use these commands exactly; all support `--format json`, and the reporting commands also support `--format markdown`.

```bash
scripts/playstore doctor --format json
scripts/playstore apps list --format json
scripts/playstore releases list --package com.example.app --track production --latest --format json
scripts/playstore health release --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format json
scripts/playstore health release --package com.example.app --track production --version-code 123 --days 7 --end-date 2026-06-08 --dimension device-model --dimension api-level --format markdown
scripts/playstore compare releases --package com.example.app --track production --current 123 --previous 122 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
scripts/playstore issues list --package com.example.app --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --type all --state all --limit 20 --format json
scripts/playstore anomalies list --package com.example.app --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --signal all --limit 20 --format json
scripts/playstore reports list --package com.example.app --issue-id ISSUE_ID --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --limit 5 --format markdown
scripts/playstore reviews recent --package com.example.app --track production --version-code 123 --days 7 --max-rating 2 --review-text redacted --format markdown
scripts/playstore report rollout-risk --package com.example.app --track production --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --format markdown
```

Valid issue types are `all`, `crash`, and `anr`. Valid issue states are `all`, `open`, and `unknown`; `open` is derived from last report time in the requested interval, not from a Play lifecycle state. Health dimensions are `api-level`, `device-model`, `country`, and `app-version`; repeat `--dimension` for multiple slices. Repeat version-code flags or pass comma-separated version codes.
Valid anomaly signals are `all`, `crash`, and `anr`. Anomaly version filtering is local: anomalies with a matching `versionCode` dimension are included, and app-wide anomalies without a version dimension are retained.
Review text is redacted by default. Use `--review-text snippet` or `--review-text full` only when the user explicitly needs text examples; URL, email, phone-like, and long numeric tokens are redacted before output.

## Guided Workflow

1. Identify inputs.
   Determine package, track, current version code(s), comparison version code(s), and a complete date window. If the user only names a track or says "latest", run `releases list --latest` and parse `latest.versionCodes`, `status`, and `rolloutFraction`.

2. Establish current health.
   Run `health release` for the current version code(s). Inspect `metricGroups[].summary.rate`, `metricGroups[].summary.userPerceivedRate`, `distinctUsers.userDays`, `missingData`, and `warnings`. If a metric worsens or the user asks where it is concentrated, rerun with dimensions such as `device-model`, `api-level`, or `country`.

3. Compare against the prior release when possible.
   Run `compare releases` with `--current` and `--previous`. Treat `summary.highestSeverity` as the top-level label, then explain the evidence from `metrics`, `issues.newIssues`, `issues.resurfacedIssues`, `issues.worsenedIssues`, and `warnings`.

4. Inspect top issues when health is degraded.
   Run `issues list` for the current version code(s), keeping `--type all` unless the user asks for only crashes or ANRs. Prioritize user-perceived issues, affected users, event count, growth, recency, and any high-risk or investigate labels from the comparison report.

5. Fetch representative reports for specific issues.
   For the top issue IDs, run `reports list` with a small `--limit`. Use the extracted stack traces and device/API metadata to summarize likely failure shape. If local source mapping is needed, switch to the `play-store-crash-triage` skill and run `triage stacktrace`.

6. Correlate recent review complaints when user sentiment matters.
   Run `reviews recent` for the current version code(s), especially with `--max-rating 2`, to summarize crash, freeze, and ANR keyword complaints. Treat the classifier as a triage signal; quote no review text unless an explicit `--review-text` mode was chosen.

7. Generate a rollout-risk decision aid when considering rollout expansion.
   Run `report rollout-risk` for the release version code(s) and complete date window. Inspect `facts.health`, `facts.topIssues`, `facts.anomalies`, and `facts.reviews` as measured facts, then treat `recommendation.category`, `recommendation.score`, and `recommendation.reasons` as inferred guidance only.

8. Report measured facts separately from recommendations.
   State the package, track, version code(s), date window, commands run, top signals, top issue IDs, data gaps, and uncertainty. For `high-risk` findings, say that a human release owner should manually review rollout in Play Console before expansion; do not claim the plugin can or did change rollout state.

## Interpretation Notes

- Empty result sets can mean no returned Play data for the filters, incomplete reporting, wrong version codes, or allowlist/auth issues. Check warnings before concluding the release is healthy.
- `compare releases` labels severity as `monitor`, `investigate`, or `high-risk`; use those as triage labels, not as automatic rollout commands.
- `report rollout-risk` recommendations are `continue monitoring`, `investigate before increasing rollout`, or `manually halt rollout outside the plugin`. They are inferred decision aids, never automated rollout actions.
- Missing previous-release metric rows make deltas incomplete. Call out this limitation plainly.
- Low-volume regressions may be noisy. Keep the recommendation proportional to affected users, user-perceived impact, recency, and data completeness.
- Avoid exposing full report text unless needed. Summarize stack traces and device slices by default.
- Review keyword matches are language-neutral where possible through technical tokens such as `ANR`, native crash signals, and common crash/freeze wording; they are indicators, not proof of a specific root cause.

## Example Prompts

- "Use Play Store release health to check the latest production release of `com.example.app` for June 1 through June 8."
- "Compare version code 123 against 122 for crashes and ANRs, then tell me what got worse."
- "Slice the current release crash rate by device model and API level."
- "Summarize recent low-rating reviews for crash, freeze, or ANR complaints on version code 123."
- "We are considering increasing rollout. Check the Play vitals signals and list any issues a release owner should review manually."
- "Generate a rollout risk report for production version code 123 from June 1 through June 8."

## Final Response Checklist

- Include the exact date window and remind that `--end-date` was exclusive when relevant.
- Include the release identifiers inspected: package, track, version code(s), and previous version code(s) if compared.
- List important warnings, missing data, or search caps.
- Identify the top metric or issue regressions with issue IDs when available.
- Include review complaint counts and version correlation when `reviews recent` was run, and state whether review text stayed redacted.
- For rollout-risk reports, separate `facts` from `recommendation` and quote the recommendation category exactly.
- Keep rollout guidance read-only: recommend investigation or manual review, never automated mutation.
