# Session Detail (copilot-cli)

Log: `<fixtures>/copilot-cli/events.jsonl`

## Meta

| key | value |
| --- | --- |
| sessionId | sess-cli-1 |
| copilotVersion | 1.0.68 |
| cwd | /proj/cli |
| repository | me/repo |
| branch | master |

## Models

- gpt-5.4

## Event counts

| event | count |
| --- | --- |
| assistant.turn_start | 2 |
| assistant.message | 2 |
| assistant.turn_end | 2 |
| session.start | 1 |
| session.model_change | 1 |

## Assistant messages

_Copilot CLI records output tokens only (no input/cache)._

| timestamp | model | phase | out | turn |
| --- | --- | --- | --- | --- |
| 2026-06-03T00:00:05.000Z | gpt-5.4 | final_answer | 100 | 0 |
| 2026-06-03T00:00:14.000Z | gpt-5.4 | final_answer | 250 | 1 |
