import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

test('claude: official subagent path creates a distinct child linked to its parent', async () => {
  const childPath = fx(
    'claude-multi-agent/-proj-claude/parent-session/subagents/agent-alpha.jsonl'
  );
  const m = await claudeParser.parseFile(childPath);
  assert.ok(m);
  assert.equal(m.sessionId, 'parent-session/agent-alpha');
  assert.equal(m.parentSessionId, 'parent-session');
  assert.equal(m.project, '/proj/claude', 'project fallback must skip parent/subagents directories');
  assert.equal(m.metricScope, 'own');
  assert.equal(m.turns, 1);
  assert.equal(m.tokens.input, 11);
  assert.equal(m.tokens.output, 7);
  assert.equal(m.tokens.cacheRead, 3);
  assert.equal(m.tokens.cacheWrite, 2);
  assert.equal(claudeParser.isLogFile(childPath), true);
  assert.equal(
    claudeParser.isLogFile(join(childPath, '..', 'not-an-agent.jsonl')),
    false,
    'only documented agent-*.jsonl files are accepted inside subagents/'
  );
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

test('copilot: tolerates holes in requests[] (index-addressed incremental log)', async () => {
  // requests[1] is never written -> sparse array with an undefined hole.
  const m = await copilotParser.parseFile(fx('copilot-sparse.jsonl'));
  assert.ok(m, 'must not throw on sparse requests');
  assert.equal(m.turns, 2, 'holes are not counted as turns');
  assert.equal(m.tokens.input, 800);
  assert.equal(m.tokens.output, 150);
  assert.equal(m.costUsd, 0.04, '(2.5 + 1.5) credits x $0.01');
});

test('copilot: Push appends requests instead of replacing completed requests', async () => {
  const m = await copilotParser.parseFile(fx('copilot-sequential-push.jsonl'));
  assert.ok(m);
  assert.equal(m.turns, 2);
  assert.equal(m.tokens.input, 3000);
  assert.equal(m.tokens.output, 300);
  assert.equal(m.costUsd, 0.04);
  assert.equal(m.costSource, 'actual');
  assert.equal(m.metricScope, 'own');
});

test('copilot: Delete removes an ObjectMutationLog request', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'aimet-delete-')), 'session.jsonl');
  writeFileSync(path, [
    { kind: 0, v: { sessionId: 'delete-session', creationDate: 1000, requests: [
      { timestamp: 1000, promptTokens: 10, completionTokens: 1, copilotCredits: 0.1 },
      { timestamp: 2000, promptTokens: 20, completionTokens: 2, copilotCredits: 0.2 },
    ] } },
    { kind: 3, k: ['requests', 0] },
  ].map(JSON.stringify).join('\n'));
  const m = await copilotParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.turns, 1);
  assert.equal(m.tokens.input, 20);
  assert.equal(m.costUsd, 0.002);
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

test('copilot subagent: exact AIU wins, zero AIU is actual, duplicate span is ignored', async () => {
  const m = await copilotSubagentParser.parseFile(fx('copilot-subagent-actual.jsonl'));
  assert.ok(m);
  assert.equal(m.parentSessionId, 'parent_actual');
  assert.equal(m.turns, 3, 'unique LLM requests when turn_start is absent');
  assert.equal(m.tokens.input, 80 + 40 + 30);
  assert.equal(m.tokens.cacheRead, 20 + 10);
  assert.equal(m.tokens.output, 20 + 10 + 5);
  assert.equal(m.costUsd, 0.0075);
  assert.equal(m.estimated, false);
  assert.equal(m.costSource, 'actual');
  assert.equal(m.metricScope, 'own');
});

test('copilot subagent: combines exact AIU with per-request fallback as mixed', async () => {
  const m = await copilotSubagentParser.parseFile(fx('copilot-subagent-mixed.jsonl'));
  assert.ok(m);
  // exact: 0.5 AIC * $0.01; fallback: 100 in, 30 out, 100 cached at gpt-5.2 rates
  const fallback = (100 * 1.75 + 30 * 14 + 100 * 0.175) / 1e6;
  assert.equal(m.costUsd, 0.005 + fallback);
  assert.equal(m.estimated, true);
  assert.equal(m.costSource, 'mixed');
});

test('copilot subagent: rejects unrelated span files via isLogFile', () => {
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/main.jsonl'), true);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/title-a.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/categorization-a.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/summarize-a.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/futureAgent-a.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/runSubagent-Explore-call_1.jsonl'), true);
  assert.equal(copilotSubagentParser.isLogFile('/x/GitHub.copilot-chat/debug-logs/u/searchSubagent-call_1.jsonl'), true);
  assert.equal(copilotSubagentParser.isLogFile('/other/debug-logs/u/main.jsonl'), false);
});

test('copilot child discovery follows main child_session_ref beyond known filename prefixes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-child-ref-'));
  const dir = join(root, 'GitHub.copilot-chat', 'debug-logs', 'parent');
  mkdirSync(dir, { recursive: true });
  const childName = 'futureAgent-call_1.jsonl';
  writeFileSync(join(dir, 'main.jsonl'), JSON.stringify({
    type: 'child_session_ref',
    attrs: { childSessionId: 'future-child', childLogFile: childName },
  }) + '\n');
  writeFileSync(join(dir, childName), [
    { ts: 1, sid: 'future-child', type: 'session_start', attrs: { parentSessionId: 'parent' } },
    { ts: 2, dur: 1, sid: 'future-child', type: 'llm_request', spanId: 'r1', attrs: {
      inputTokens: 10, cachedTokens: 4, outputTokens: 2, copilotUsageNanoAiu: 0,
    } },
  ].map(JSON.stringify).join('\n'));

  assert.equal(copilotSubagentParser.isLogFile(join(dir, childName)), true);
  const child = await copilotSubagentParser.parseFile(join(dir, childName));
  assert.ok(child);
  assert.equal(child.parentSessionId, 'parent');
  assert.equal(child.tokens.input, 6);
  assert.equal(child.tokens.cacheRead, 4);
});

test('copilot search subagent is an exact zero-credit child session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-search-child-'));
  const dir = join(root, 'GitHub.copilot-chat', 'debug-logs', 'parent-session-1');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'searchSubagent-call_search_fixture.jsonl');
  copyFileSync(fx('copilot-debug/searchSubagent-call_search_fixture.jsonl'), path);
  assert.equal(copilotSubagentParser.isLogFile(path), true);
  const child = await copilotSubagentParser.parseFile(path);
  assert.ok(child);
  assert.equal(child.sessionId, 'call_search_fixture');
  assert.equal(child.parentSessionId, 'parent-session-1');
  assert.deepEqual(child.tokens, {
    input: 20, output: 10, cacheRead: 80, cacheWrite: null, reasoning: null,
  });
  assert.equal(child.costUsd, 0);
  assert.equal(child.costSource, 'actual');
  assert.equal(child.estimated, false);
});

test('copilot parent main span is exact and own-scoped', async () => {
  const m = await copilotSubagentParser.parseFile(fx('copilot-debug/main.jsonl'));
  assert.ok(m);
  assert.equal(m.sessionId, 'parent-session-1');
  assert.equal(m.parentSessionId, null);
  assert.equal(m.tokens.input, 600);
  assert.equal(m.tokens.cacheRead, 400);
  assert.equal(m.tokens.output, 100);
  assert.equal(m.costUsd, 0.0125);
  assert.equal(m.costSource, 'actual');
  assert.equal(m.metricScope, 'own');
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
  // Copilot CLI does not record input/cache tokens -> null (not a measured 0).
  assert.equal(m.tokens.input, null);
  assert.equal(m.tokens.cacheRead, null);
  assert.equal(m.tokens.cacheWrite, null);
  assert.equal(m.tokens.reasoning, null);
  // Input unknown -> no meaningful API-equivalent cost.
  assert.equal(m.costUsd, null, 'cost must be null, not a misleading output-only figure');
});
