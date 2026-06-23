---
name: play-store-crash-triage
description: Triage Google Play crash and ANR issues with the repo-local read-only Play Store CLI. Use when asked to list top crash or ANR issues, fetch representative Play error reports, compare crash regressions, map stack traces to local Kotlin or Java files, or investigate a user-provided stack trace against a local Android source tree.
---

# Play Store Crash Triage

## Overview

Use this skill to move from Play crash or ANR symptoms to concrete issue IDs, representative reports, stack traces, and likely local source files. Prefer JSON output for parsing and Markdown output when the user asks for a readable triage report.

This plugin is read-only. The CLI can inspect Play Console data and local files, but it must not mutate Play releases, respond to reviews, pause rollouts, or make rollout changes. Any halt, rollback, or rollout increase is a manual decision outside the plugin.

## Command Reference

Run from the plugin repository root. Use `scripts/playstore doctor --format json` first when setup is uncertain.

```bash
scripts/playstore issues list --package com.example.app --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --type all --state all --limit 20 --format json
scripts/playstore reports list --package com.example.app --issue-id ISSUE_ID --version-code 123 --start-date 2026-06-01 --end-date 2026-06-08 --type crash --limit 5 --format json
scripts/playstore compare releases --package com.example.app --track production --current 123 --previous 122 --start-date 2026-06-01 --end-date 2026-06-08 --type all --limit 20 --format markdown
scripts/playstore triage stacktrace --file /tmp/playstore-stacktrace.txt --source-root /path/to/android/source --max-files 10 --format json
scripts/playstore triage stacktrace --source-root /path/to/android/source --git --format markdown < /tmp/playstore-stacktrace.txt
```

`issues list` requires at least one `--version-code` and a complete date range. `reports list` requires `--issue-id`; its date range is optional, but pass the same window and version code(s) when investigating a release. `triage stacktrace` is local-only and accepts `--file`, `--stacktrace`, or stdin; use `--git` only when local blame/recent commit hints would help.

## Guided Workflow

1. Anchor the investigation.
   Determine package, version code(s), date window, issue type (`all`, `crash`, or `anr`), and whether the user has a local source tree. Use absolute dates; `--end-date` is exclusive and Play vitals use `America/Los_Angeles`.

2. Find or confirm the issue.
   If the user gave an issue ID, keep it. Otherwise run `issues list`, then prioritize issues with high affected users, event count, growth, recency, and user-perceived impact. Preserve issue IDs exactly for follow-up commands.

3. Fetch representative reports.
   Run `reports list` for the selected issue with the relevant version code(s), date window, type filter, and a small limit. Inspect `reports[].stackTrace`, `device`, `apiLevel`, `eventTime`, `versionCode`, `vcsInformation`, and `warnings`.

4. Triage stack traces locally.
   Write only the selected stack trace frames to a temporary file outside the repo, such as `/tmp/playstore-stacktrace.txt`, or pipe the trace through stdin. Run `triage stacktrace` against the Android source root. Read `summary.confidence`, `suspectFiles`, `frames[].candidates`, obfuscation warnings, and parse warnings before naming likely files.

5. Compare release regression context when needed.
   If the user asks whether a release got worse, or if top issues look new, run `compare releases` with the current and previous version code(s). Use the comparison severity labels (`monitor`, `investigate`, `high-risk`) as triage labels only.

6. Give a concise triage result.
   Report the top issue ID(s), crash/ANR type, affected users/events, growth, user-perceived impact, representative exception or signal, devices/API slices if visible, likely source files with confidence, and next debugging actions. Separate measured Play facts from source-code hypotheses.

## Local Stack Trace Only

When the user provides a stack trace without Play Console context, skip Play data commands and run local triage directly:

```bash
scripts/playstore triage stacktrace --file crash.txt --source-root /path/to/android/source --format markdown
```

If the trace is obfuscated or has missing source lines, say so. Do not overclaim causation from a package/class/method match; phrase matches as likely investigation starting points.

## Safety And Privacy Notes

- Keep the plugin read-only. Do not invent or request rollout mutation commands.
- Do not commit fetched reports, raw stack traces, credentials, or generated scratch files.
- Prefer summarizing report text and stack traces. Quote only the minimum frames needed for debugging.
- Treat local source matches as hypotheses unless supported by code inspection, repro steps, or a clear recent change.
- If the CLI returns auth, allowlist, or no-data warnings, include them in the result instead of treating missing data as proof of safety.

## Example Prompts

- "Use Play Store crash triage to find the top crash issues for version code 123 from June 1 through June 8."
- "Fetch reports for issue `abc123` and map the stack trace to this Android repo."
- "This stack trace came from production. Triage it against `/work/app` and tell me the likely Kotlin files."
- "Compare version 123 to 122 for crash regressions, then pull representative reports for the highest-risk issue."

## Final Response Checklist

- Include package, version code(s), date window, issue type, and commands run.
- Name issue IDs and report IDs when available.
- Summarize representative stack traces without dumping unnecessary report text.
- List suspect files with confidence and the matching frames that justify them.
- Include warnings, obfuscation limits, missing data, and any manual Play Console decision points.
