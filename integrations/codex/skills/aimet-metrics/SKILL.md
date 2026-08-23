---
name: aimet-metrics
description: Collect and show local Codex token, cost, activity, and subagent metrics with aimet. Use when the user asks about the current session's AI usage, a recent or periodic usage report, per-project totals, token counts, costs, or parent/subagent accounting.
---

# aimet Metrics

## Overview

Use the locally installed `aimet` command to collect Codex session logs and present its metrics without changing their meaning. Preserve `n/a`, estimated-value markers, and parent/subagent distinctions: they communicate important limits in the source data.

## Current Session

1. Run `aimet hook codex` so the transcript path supplied by a Codex completion hook is collected when available.
2. Run `aimet session --tool codex`.
3. Present the command output as-is. Explain a field only if the user asks or the result contains a warning.

## Period Reports

Choose the grouping requested by the user. Examples:

```sh
aimet collect --tool codex --since 7
aimet report --period weekly --by project
```

For a different window or grouping, use the documented `aimet collect` and `aimet report` options. Do not substitute missing values with zero. A cost shown as `n/a` means the source lacked enough model or pricing data to calculate it reliably.

For an individual log, use `aimet detail --tool codex --file <path>` only when the user wants diagnostic detail. The detail view is not an extra usage total and must not be added to report totals.
