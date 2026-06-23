# Example Prompts

Use absolute dates. Play vitals date windows treat `--end-date` as exclusive.

## Release Health

- "Use Play Store release health to check production version code 123 of `com.example.app` from 2026-06-01 through 2026-06-08."
- "Find the latest production release for `com.example.app`, then summarize crash and ANR health for the last 7 complete days ending 2026-06-08."
- "Slice crash and ANR health for version code 123 by device model and API level from 2026-06-01 through 2026-06-08."

## Release Comparison

- "Compare production version code 123 against 122 for crashes and ANRs from 2026-06-01 through 2026-06-08."
- "Tell me which issues are new, resurfaced, worsened, or fixed between version codes 123 and 122."
- "Check whether the current release has any high-risk crash or ANR regressions before rollout expansion."

## Crash And ANR Triage

- "List the top crash and ANR issues for `com.example.app` version code 123 from 2026-06-01 through 2026-06-08."
- "Fetch representative reports for issue `issue-top` and summarize the exception, device/API pattern, and stack trace shape."
- "Map this production stack trace to `/path/to/android/source` and list likely Kotlin or Java files with confidence."

## Review Signals

- "Summarize recent one- and two-star reviews for crash, freeze, or ANR complaints on version code 123 from 2026-06-01 through 2026-06-08. Keep review text redacted."
- "Correlate low-rating review complaints with the latest production release of `com.example.app`."
- "Show whether review complaints mention crashes or freezes after version code 123, without printing raw review text."

## Rollout Risk

- "Generate a rollout risk report for production version code 123 of `com.example.app` from 2026-06-01 through 2026-06-08."
- "We are considering increasing rollout. Separate measured facts from the recommendation and tell me what a release owner should review manually."
- "Run the rollout-risk report with health, top issues, anomalies, and low-rating review signals. Do not make any Play Console changes."

## Setup And Validation

- "Run the Play Store plugin doctor and summarize any local setup warnings."
- "Validate the plugin manifest, build, tests, and fixture JSON from a clean checkout."
- "Use the example fixtures to explain what each Play API response shape is for."
