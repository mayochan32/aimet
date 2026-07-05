import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { claudeParser } from '../dist/parsers/claude.js';
import { codexParser } from '../dist/parsers/codex.js';
import { copilotParser } from '../dist/parsers/copilot.js';

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
