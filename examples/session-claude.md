# Session parent-session

| item | value |
| --- | --- |
| tool | claude |
| project | /proj/claude |
| model | claude-sonnet-4-6 |
| started | 2026-08-23 00:00:00 (+00:00) |
| ended | 2026-08-23 00:00:01 (+00:00) |
| active / wall | 0.00h / 0.00h |
| turns | 1 |
| input tokens | 100 |
| output tokens | 10 |
| cache read | 50 |
| cache write | 5 |
| reasoning | - |
| cost | $0.0005 (API-equivalent) |
| log file | <fixtures>/claude/parent-session.jsonl |

## Subagents

| session | model | turns | in | out | cacheR | active | cost($) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| parent-session/agent-alpha | claude-sonnet-4-6 | 1 | 11 | 7 | 3 | 0.00h | 0.0001 |
| parent-session/agent-beta | claude-sonnet-4-6 | 1 | 13 | 9 | 4 | 0.00h | 0.0002 |

**TOTAL (parent + subagents)**: in 124 / out 26 / cacheR 57 / $0.0008 (API-equivalent)
