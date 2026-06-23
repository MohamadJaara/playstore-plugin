# Mocked API Fixtures

These files are fake mocked Google Play responses for tests, demos, and parser development. They are safe to commit and must not contain real package data, real user review text, credentials, tokens, or raw production crash reports.

| File | Mocked endpoint or client method |
| --- | --- |
| `play-publisher-releases-production.json` | Android Publisher `applications/{package}/tracks/{track}/releases` |
| `play-publisher-reviews.json` | Android Publisher `applications/{package}/reviews` |
| `reporting-crash-metrics-query.json` | Play Developer Reporting crash metric set query |
| `reporting-anr-metrics-query.json` | Play Developer Reporting ANR metric set query |
| `reporting-error-issues.json` | Play Developer Reporting `errorIssues:search` |
| `reporting-error-reports.json` | Play Developer Reporting `errorReports:search` |
| `reporting-anomalies.json` | Play Developer Reporting `anomalies` |

The CLI clients normalize these raw response shapes into domain models before command code ranks issues, summarizes health, classifies reviews, or scores rollout risk.
