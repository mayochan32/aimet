import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { claudeParser } from '../dist/parsers/claude.js';
import { codexParser } from '../dist/parsers/codex.js';
import { copilotParser } from '../dist/parsers/copilot.js';
import { copilotCliParser } from '../dist/parsers/copilotcli.js';
import { copilotSubagentParser } from '../dist/parsers/copilotsubagent.js';

const fx = (name) => join(import.meta.dirname, 'fixtures', name);

test('claude: sums usage, dedups retried message id, tolerates corrupt lines', async () => {
  const m = await claudeParser.parseFile(fx('claude-basic.jsonl'));
  assert.ok(m, 'should parse');
  assert.equal(m.tool, 'claude');
  assert.equal(m.sessionId, 'sess-claude-1');
  assert.equal(m.project, '/proj/claude');
  assert.equal(m.model, 'claude-sonnet-4-6');
  // msg_A appears twice (retry) -> counted once; msg_B once => 2 turns
  assert.equal(m.turns, 2, 'retried duplicate must not inflate turns');
  assert.equal(m.tokens.input, 8, '3 + 5 (duplicate excluded)');
  assert.equal(m.tokens.output, 30, '10 + 20');
  assert.equal(m.tokens.cacheRead, 300, '100 + 200');
  assert.equal(m.tokens.cacheWrite, 20, 'duplicate cacheW excluded');
  assert.equal(m.estimated, false);
  assert.ok(typeof m.costUsd === 'number' && m.costUsd > 0, 'known model -> cost');
});

test('claude: unknown model yields null cost', async () => {
  const m = await claudeParser.parseFile(fx('claude-unknown-model.jsonl'));
  assert.ok(m);
  assert.equal(m.costUsd, null, 'unknown model must not be costed as 0');
});

test('codex: uses max cumulative usage and splits cached input', async () => {
  const m = await codexParser.parseFile(fx('codex-basic.jsonl'));
  assert.ok(m);
  assert.equal(m.model, 'gpt-5.2');
  assert.equal(m.estimated, false);
  assert.equal(m.turns, 1, 'one task_started');
  // largest total (20500) wins; input = 20000 - 5000 cached
  assert.equal(m.tokens.input, 15000);
  assert.equal(m.tokens.cacheRead, 5000);
  assert.equal(m.tokens.output, 500);
  assert.equal(m.tokens.reasoning, 200);
});

test('codex: unknown model falls back to pricing but is flagged estimated', async () => {
  const m = await codexParser.parseFile(fx('codex-nomodel.jsonl'));
  assert.ok(m);
  assert.equal(m.model, 'gpt-5-codex', 'fallback model');
  assert.equal(m.estimated, true, 'guessed unit price must be flagged estimated');
});

test('copilot: reduces incremental diffs and prefers actual credit cost', async () => {
  const m = await copilotParser.parseFile(fx('copilot-basic.jsonl'));
  assert.ok(m);
  assert.equal(m.tool, 'copilot');
  assert.equal(m.turns, 1);
  assert.equal(m.tokens.input, 1000);
  assert.equal(m.tokens.output, 200);
  assert.equal(m.model, 'gpt-5.2-codex');
  assert.equal(m.estimated, false, 'credits present -> actual cost');
  assert.equal(m.costUsd, 0.05, '5 credits x $0.01');
});

test('codex subagent (multi-agent v2): keys by own thread id and links parent', async () => {
  const m = await codexParser.parseFile(fx('codex-subagent-basic.jsonl'));
  assert.ok(m);
  // payload.id is the thread's own id; payload.session_id is the PARENT.
  assert.equal(m.sessionId, 'aaaa1111-0000-0000-0000-000000000001');
  assert.equal(m.parentSessionId, 'bbbb2222-0000-0000-0000-000000000002');
  assert.match(m.model, /\(subagent:guardian\)$/);
  assert.equal(m.tokens.input, 111254 - 85888);
  assert.equal(m.tokens.cacheRead, 85888);
});

test('copilot subagent: parses span traces, splits cached input, links parent', async () => {
  const m = await copilotSubagentParser.parseFile(fx('copilot-subagent-basic.jsonl'));
  assert.ok(m);
  assert.equal(m.tool, 'copilot');
  assert.equal(m.sessionId, 'call_TESTSUBAGENT01');
  assert.equal(m.parentSessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(m.turns, 2, 'two turn_start');
  // inputTokens includes cachedTokens -> split: (11339-2560) + (20000-15000)
  assert.equal(m.tokens.input, 8779 + 5000);
  assert.equal(m.tokens.cacheRead, 2560 + 15000);
  assert.equal(m.tokens.output, 421 + 1000);
  assert.match(m.model, /^gpt-5\.4-mini/);
  assert.equal(m.estimated, true, 'span logs carry no credits -> API-equivalent estimate');
  assert.ok(m.costUsd > 0);
});

test('copilot subagent: rejects non-subagent span files via isLogFile', () => {
  assert.equal(copilotSubagentParser.isLogFile('/x/debug-logs/u/main.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/debug-logs/u/title-a.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/debug-logs/u/runSubagent-Explore-call_1.jsonl'), true);
});

test('copilot-cli: sums output tokens, counts turns, leaves input/cost unknown', async () => {
  const m = await copilotCliParser.parseFile(fx('copilotcli-basic.jsonl'));
  assert.ok(m);
  assert.equal(m.tool, 'copilot-cli');
  assert.equal(m.sessionId, 'sess-cli-1');
  assert.equal(m.project, '/proj/cli');
  assert.equal(m.model, 'gpt-5.4');
  assert.equal(m.turns, 2, 'two assistant.turn_start');
  assert.equal(m.tokens.output, 350, '100 + 250 (corrupt line skipped)');
  // Copilot CLI does not record input/cache tokens.
  assert.equal(m.tokens.input, 0);
  assert.equal(m.tokens.cacheRead, 0);
  assert.equal(m.tokens.cacheWrite, 0);
  // Input unknown -> no meaningful API-equivalent cost.
  assert.equal(m.costUsd, null, 'cost must be null, not a misleading output-only figure');
});
