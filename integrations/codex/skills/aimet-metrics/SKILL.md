---
name: aimet-metrics
description: Collect and display local Codex usage metrics with aimet. Use when the user asks for the current session's token usage, cost, activity time, subagent totals, or a daily, weekly, or monthly usage report.
---

# aimet Metrics

Use the installed `aimet` CLI to collect local Codex session logs and present its output.

## Current session

1. Run `aimet hook codex` to ingest recent Codex logs.
2. Run `aimet session --tool codex`.
3. Present the command output without changing the numeric values or cost labels.

## Period report

Match the user's requested period and grouping. For example, use
`aimet report --period weekly --by project` for a weekly project report. Run
`aimet --help` if another option is needed.

Treat `-`, `n/a`, estimated markers, and tool-specific cost labels as meaningful.
Do not turn unavailable data into zero or describe API-equivalent estimates as
actual billed cost. Refer the user to aimet's README for collection limitations.
