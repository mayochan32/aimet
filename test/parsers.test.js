import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { claudeParser } from '../dist/parsers/claude.js';
import { codexParser } from '../dist/parsers/codex.js';
import { copilotParser } from '../dist/parsers/copilot.js';
import { copilotCliParser } from '../dist/parsers/copilotcli.js';
import { copilotSubagentParser } from '../dist/parsers/copilotsubagent.js';
import { copilotOtelParser, copilotCliOtelParser } from '../dist/parsers/copilototel.js';

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

test('claude: prices switched models and advisor usage per inference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-claude-models-'));
  const file = join(root, 'models.jsonl');
  const record = (id, timestamp, model, usage) => JSON.stringify({
    type: 'assistant', timestamp, sessionId: 'models', cwd: '/project',
    message: { id, model, usage },
  });
  writeFileSync(file, [
    record('a', '2026-09-20T00:00:00.000Z', 'claude-sonnet-5', {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [
        { type: 'message', input_tokens: 100, output_tokens: 10 },
        { type: 'advisor_message', model: 'claude-opus-5', input_tokens: 20,
          output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    }),
    record('b', '2026-09-20T00:00:01.000Z', 'claude-opus-5', {
      input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
  ].join('\n'));
  const m = await claudeParser.parseFile(file);
  assert.ok(m);
  assert.equal(m.model, 'mixed');
  assert.equal(m.tokens.input, 150);
  assert.equal(m.tokens.output, 19);
  assert.equal(m.costUsd, (100 * 2 + 10 * 10 + 20 * 5 + 5 * 25 + 30 * 5 + 4 * 25) / 1e6);
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

for (const [model, expected, expectedMissingWrite] of [
  ['gpt-5.6-sol', 2.05, 0.0212],
  ['gpt-6-sol', 1.025, 0.0106],
  ['gpt-6-luna', 0.05125, 0.00053],
  ['gpt-6.1-sol', 1.0, 0.0098],
]) {
test(`codex: ${model} splits cache writes and prices each long-context request`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-gpt56-'));
  const path = join(root, 'rollout-2026-08-25T00-00-00-gpt56-pricing.jsonl');
  const first = {
    input_tokens: 300_000,
    cached_input_tokens: 100_000,
    cache_write_input_tokens: 50_000,
    output_tokens: 1_000,
    reasoning_output_tokens: 100,
    total_tokens: 301_000,
  };
  const second = {
    input_tokens: 100_000,
    cached_input_tokens: 50_000,
    cache_write_input_tokens: 10_000,
    output_tokens: 500,
    reasoning_output_tokens: 50,
    total_tokens: 100_500,
  };
  const total = Object.fromEntries(
    Object.keys(first).map((key) => [key, first[key] + second[key]])
  );
  const records = [
    { timestamp: '2026-08-25T00:00:00.000Z', type: 'session_meta', payload: {
      id: 'gpt56-pricing', session_id: 'gpt56-pricing', cwd: '/proj/gpt56',
    } },
    { timestamp: '2026-08-25T00:00:01.000Z', type: 'turn_context', payload: {
      model, cwd: '/proj/gpt56',
    } },
    { timestamp: '2026-08-25T00:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: first, last_token_usage: first },
    } },
    { timestamp: '2026-08-25T00:00:03.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: total, last_token_usage: second },
    } },
  ];
  writeFileSync(path, records.map(JSON.stringify).join('\n') + '\n');

  const m = await codexParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.tokens.input, 190_000);
  assert.equal(m.tokens.cacheRead, 150_000);
  assert.equal(m.tokens.cacheWrite, 60_000);
  assert.equal(m.tokens.output, 1_500);
  assert.equal(m.tokens.reasoning, 150);
  assert.ok(Math.abs(m.costUsd - expected) < 1e-12);
  assert.equal(m.estimated, false);
});

test(`codex: ${model} old rollout without cache-write detail is explicitly estimated`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-gpt56-old-'));
  const path = join(root, 'rollout-2026-08-25T00-00-00-gpt56-old.jsonl');
  const total = {
    input_tokens: 10_000,
    cached_input_tokens: 8_000,
    output_tokens: 500,
    reasoning_output_tokens: 50,
    total_tokens: 10_500,
  };
  const records = [
    { timestamp: '2026-08-25T00:00:00.000Z', type: 'session_meta', payload: {
      id: 'gpt56-old', session_id: 'gpt56-old', cwd: '/proj/gpt56-old',
    } },
    { timestamp: '2026-08-25T00:00:01.000Z', type: 'turn_context', payload: {
      model, cwd: '/proj/gpt56-old',
    } },
    { timestamp: '2026-08-25T00:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: total, last_token_usage: total },
    } },
  ];
  writeFileSync(path, records.map(JSON.stringify).join('\n') + '\n');

  const m = await codexParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.tokens.input, 2_000);
  assert.equal(m.tokens.cacheRead, 8_000);
  assert.equal(m.tokens.cacheWrite, null);
  assert.ok(Math.abs(m.costUsd - expectedMissingWrite) < 1e-12);
  assert.equal(m.estimated, true);
});

}

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
  assert.equal(m.accessMode, 'copilot');
  assert.equal(m.metricScope, 'own');
});

test('copilot: estimated cost bills cached context at the cache-read rate', async () => {
  const m = await copilotParser.parseFile(fx('copilot-estimated-with-cache.jsonl'));
  assert.ok(m);
  assert.equal(m.estimated, true, 'no Copilot credits -> API-equivalent estimate');
  assert.equal(m.tokens.input, 1000, '5% of promptTokens is uncached input');
  assert.equal(m.tokens.cacheRead, 19000, '95% of promptTokens is cached input');
  assert.equal(m.tokens.output, 500);
  // claude-sonnet-4 pricing: input $3/M, output $15/M, cache read $0.3/M.
  assert.equal(m.costUsd, 0.0162);
});

test('copilot: recognizes a qualified Custom Endpoint model as BYOK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-customendpoint-'));
  const path = join(root, 'session.jsonl');
  writeFileSync(path, JSON.stringify({
    kind: 0,
    v: {
      sessionId: 'customendpoint-chat',
      creationDate: 1783373827000,
      requests: [{
        timestamp: 1783373827000,
        promptTokens: 1000,
        completionTokens: 100,
        copilotCredits: 0,
        modelId: 'customendpoint/gpt-5-nano',
        result: { metadata: { resolvedModel: 'gpt-5-nano-2025-08-07' } },
        modelState: { completedAt: 1783373828000 },
      }],
    },
  }) + '\n');

  const m = await copilotParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.model, 'gpt-5-nano-2025-08-07');
  assert.equal(m.accessMode, 'byok');
  assert.equal(m.provider, 'custom');
  assert.equal(m.costSource, 'estimated');
  assert.equal(m.estimated, true);
  assert.ok(m.costUsd > 0, 'BYOK uses provider-side API-equivalent pricing');
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

test('codex subagent: current parent_thread_id metadata links the separate rollout', async () => {
  const m = await codexParser.parseFile(fx('codex-subagent-current.jsonl'));
  assert.ok(m);
  assert.equal(m.sessionId, 'cccc3333-0000-0000-0000-000000000003');
  assert.equal(m.parentSessionId, 'dddd4444-0000-0000-0000-000000000004');
  assert.match(m.model, /\(subagent:explorer\)$/);
  assert.equal(m.tokens.input, 400);
  assert.equal(m.tokens.cacheRead, 600);
});

test('codex subagent identity is independent of parent/child session_meta order', async () => {
  const lines = readFileSync(fx('codex-subagent-current.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).payload.thread_source, 'subagent');
  assert.equal(JSON.parse(lines[1]).payload.thread_source, 'user');

  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-meta-order-'));
  const path = join(root, 'rollout-parent-before-child.jsonl');
  writeFileSync(path, [lines[1], lines[0], ...lines.slice(2)].join('\n') + '\n');

  const m = await codexParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.sessionId, 'cccc3333-0000-0000-0000-000000000003');
  assert.equal(m.parentSessionId, 'dddd4444-0000-0000-0000-000000000004');
  assert.match(m.model, /\(subagent:explorer\)$/);
  assert.equal(m.tokens.input, 400);
  assert.equal(m.tokens.cacheRead, 600);
});

test('codex repeated equivalent session_meta records are harmless', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-meta-repeat-'));
  const path = join(
    root,
    'rollout-2026-08-23T01-00-00-eeee5555-0000-0000-0000-000000000005.jsonl'
  );
  const meta = {
    timestamp: '2026-08-23T01:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'eeee5555-0000-0000-0000-000000000005',
      session_id: 'eeee5555-0000-0000-0000-000000000005',
      thread_source: 'user',
      cwd: '/proj/repeated',
    },
  };
  writeFileSync(path, [
    meta,
    { ...meta, timestamp: '2026-08-23T01:00:00.500Z' },
    { timestamp: '2026-08-23T01:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { timestamp: '2026-08-23T01:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: {
        input_tokens: 10, cached_input_tokens: 4, output_tokens: 2,
        reasoning_output_tokens: 1, total_tokens: 12,
      } },
    } },
  ].map(JSON.stringify).join('\n') + '\n');

  const m = await codexParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.sessionId, 'eeee5555-0000-0000-0000-000000000005');
  assert.equal(m.parentSessionId, null);
  assert.equal(m.project, '/proj/repeated');
});

test('codex rejects conflicting subagent identities instead of guessing by order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-meta-conflict-'));
  const path = join(root, 'rollout-conflicting-subagents.jsonl');
  const records = [
    { timestamp: '2026-08-23T01:00:00.000Z', type: 'session_meta', payload: {
      id: '11111111-0000-0000-0000-000000000001',
      parent_thread_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      thread_source: 'subagent',
    } },
    { timestamp: '2026-08-23T01:00:00.500Z', type: 'session_meta', payload: {
      id: '22222222-0000-0000-0000-000000000002',
      parent_thread_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      thread_source: 'subagent',
    } },
    { timestamp: '2026-08-23T01:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { timestamp: '2026-08-23T01:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: {
        input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2,
      } },
    } },
  ];
  writeFileSync(path, records.map(JSON.stringify).join('\n') + '\n');

  await assert.rejects(
    codexParser.parseFile(path),
    /ambiguous Codex subagent metadata/
  );
});

test('codex rejects conflicting parents for the same child identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-codex-parent-conflict-'));
  const childId = '33333333-0000-0000-0000-000000000003';
  const path = join(root, `rollout-2026-08-23T01-00-00-${childId}.jsonl`);
  const records = [
    { timestamp: '2026-08-23T01:00:00.000Z', type: 'session_meta', payload: {
      id: childId,
      parent_thread_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      thread_source: 'subagent',
    } },
    { timestamp: '2026-08-23T01:00:00.500Z', type: 'session_meta', payload: {
      id: childId,
      parent_thread_id: 'bbbbbbbb-0000-0000-0000-000000000002',
      thread_source: 'subagent',
    } },
    { timestamp: '2026-08-23T01:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { timestamp: '2026-08-23T01:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: {
        input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2,
      } },
    } },
  ];
  writeFileSync(path, records.map(JSON.stringify).join('\n') + '\n');

  await assert.rejects(
    codexParser.parseFile(path),
    /ambiguous Codex rollout filename/
  );
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
  assert.equal(m.accessMode, 'copilot');
});

test('copilot subagent: Custom Endpoint prefix overrides a zero AIU attribute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-subagent-customendpoint-'));
  const path = join(root, 'main.jsonl');
  writeFileSync(path, [
    { v: 1, ts: 1783373827000, dur: 0, sid: 'customendpoint-parent', type: 'session_start', attrs: {} },
    { v: 1, ts: 1783373827100, dur: 1000, sid: 'customendpoint-parent', type: 'llm_request', spanId: 'customendpoint-span', attrs: {
      inputTokens: 1000,
      cachedTokens: 400,
      outputTokens: 100,
      copilotUsageNanoAiu: 0,
      modelId: 'customendpoint/gpt-5-nano',
      model: 'gpt-5-nano-2025-08-07',
    } },
  ].map(JSON.stringify).join('\n') + '\n');

  const m = await copilotSubagentParser.parseFile(path);
  assert.ok(m);
  assert.equal(m.model, 'gpt-5-nano-2025-08-07');
  assert.equal(m.accessMode, 'byok');
  assert.equal(m.provider, 'custom');
  assert.equal(m.costSource, 'estimated');
  assert.ok(m.costUsd > 0);
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

test('copilot OTel SQLite: aggregates BYOK provider, cache write and reasoning tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-'));
  const path = join(root, 'agent-traces.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
      name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
      operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
      tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
      chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
    );
    CREATE TABLE span_attributes (
      span_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (span_id, key)
    );
  `);
  db.prepare(`INSERT INTO spans (
    span_id, trace_id, name, start_time_ms, end_time_ms, operation_name,
    provider_name, conversation_id, request_model, response_model,
    input_tokens, output_tokens, cached_tokens, reasoning_tokens
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('span-1', 'trace-1', 'chat claude-sonnet-4-6', 1783373827000, 1783373832000,
      'chat', 'github', 'byok-session-1', 'claude-sonnet-4-6', 'claude-sonnet-4-6',
      1000, 100, 400, 20);
  const attr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');
  attr.run('span-1', 'gen_ai.usage.cache_creation.input_tokens', '100');
  attr.run('span-1', 'gen_ai.usage.reasoning.output_tokens', '20');
  attr.run('span-1', 'server.address', 'api.anthropic.com');
  db.close();

  assert.equal(copilotOtelParser.isLogFile(path), true);
  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions.length, 1);
  const m = sessions[0];
  assert.equal(m.sessionId, 'byok-session-1');
  assert.equal(m.provider, 'anthropic');
  assert.equal(m.accessMode, 'byok');
  assert.equal(m.serverAddress, 'api.anthropic.com');
  assert.equal(m.model, 'claude-sonnet-4-6');
  assert.deepEqual(m.tokens, {
    input: 500, output: 100, cacheRead: 400, cacheWrite: 100, reasoning: 20,
  });
  assert.equal(m.metricScope, 'tree');
  assert.equal(m.costSource, 'estimated');
  assert.ok(Math.abs(m.costUsd - 0.003495) < 1e-12);
});

test('copilot OTel SQLite: infers a direct OpenAI BYOK call and ignores utility chats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-real-shape-'));
  const path = join(root, 'agent-traces.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
      name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
      operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
      tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
      chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
    );
    CREATE TABLE span_attributes (
      span_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (span_id, key)
    );
    INSERT INTO spans (
      span_id, trace_id, name, start_time_ms, end_time_ms, operation_name,
      provider_name, conversation_id, request_model, response_model,
      input_tokens, output_tokens, cached_tokens, reasoning_tokens
    ) VALUES
      ('byok', 'trace-byok', 'chat gpt-5', 1783373827000, 1783373832000,
       'chat', 'github', 'real-byok-session', 'gpt-5', 'gpt-5-2025-08-07', 1000, 100, 400, 20),
      ('hosted', 'trace-hosted', 'chat gpt-5', 1783373833000, 1783373835000,
       'chat', 'github', 'copilot-hosted-session', 'gpt-5', 'gpt-5', 200, 20, 0, NULL),
      ('utility', 'trace-utility', 'chat gpt-4o-mini', 1783373828000, 1783373829000,
       'chat', 'github', NULL, 'gpt-4o-mini', 'gpt-4o-mini', 100, 10, 0, NULL);
    INSERT INTO span_attributes (span_id, key, value) VALUES
      ('byok', 'server.address', 'api.openai.com'),
      ('byok', 'gen_ai.usage.reasoning.output_tokens', '20'),
      ('hosted', 'server.address', 'api.githubcopilot.com'),
      ('hosted', 'copilot_chat.copilot_usage_nano_aiu', '1000000000'),
      ('utility', 'copilot_chat.copilot_usage_nano_aiu', '0');
  `);
  db.close();

  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions.length, 2, 'conversationless utility chat is excluded');
  const byok = sessions.find((s) => s.sessionId === 'real-byok-session');
  assert.ok(byok);
  assert.equal(byok.provider, 'openai');
  assert.equal(byok.accessMode, 'byok');
  assert.equal(byok.serverAddress, 'api.openai.com');
  const hosted = sessions.find((s) => s.sessionId === 'copilot-hosted-session');
  assert.ok(hosted);
  assert.equal(hosted.provider, 'github');
  assert.equal(hosted.accessMode, 'copilot');
  assert.equal(hosted.costSource, 'actual');
});

test('copilot OTel file exporter: parses JSONL span attributes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-file-'));
  const path = join(root, 'copilot-otel.jsonl');
  writeFileSync(path, JSON.stringify({
    name: 'chat claude-sonnet-4-6',
    _spanContext: { traceId: 'trace-file-1', spanId: 'span-file-1' },
    startTime: [1783373827, 0],
    duration: [2, 500000000],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.conversation.id': 'byok-file-session-1',
      'gen_ai.response.model': 'claude-sonnet-4-6',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 100,
      'gen_ai.usage.cache_read.input_tokens': 400,
      'gen_ai.usage.cache_creation.input_tokens': 100,
      'gen_ai.usage.reasoning.output_tokens': 20,
      'server.address': 'api.anthropic.com',
    },
  }) + '\n');

  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'byok-file-session-1');
  assert.equal(sessions[0].provider, 'anthropic');
  assert.equal(sessions[0].accessMode, 'byok');
  assert.equal(sessions[0].activeSec, 3);
  assert.deepEqual(sessions[0].tokens, {
    input: 500, output: 100, cacheRead: 400, cacheWrite: 100, reasoning: 20,
  });
});

test('copilot OTel: a direct custom endpoint is BYOK even when provider is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-custom-'));
  const path = join(root, 'copilot-otel.jsonl');
  writeFileSync(path, JSON.stringify({
    _spanContext: { traceId: 'trace-custom', spanId: 'span-custom' },
    startTime: [1783373827, 0],
    duration: [1, 0],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.conversation.id': 'custom-endpoint-session',
      'gen_ai.response.model': 'private-model',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'server.address': 'llm.example.test',
    },
  }) + '\n');

  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions[0].accessMode, 'byok');
  assert.equal(sessions[0].provider, 'custom');
});

test('copilot OTel SQLite: Custom Endpoint request id survives missing route attributes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-customendpoint-db-'));
  const path = join(root, 'agent-traces.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
      name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
      operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
      request_model TEXT, response_model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
      tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
      chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
    );
    CREATE TABLE span_attributes (
      span_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (span_id, key)
    );
    INSERT INTO spans (
      span_id, trace_id, name, start_time_ms, end_time_ms, operation_name,
      provider_name, conversation_id, request_model, response_model,
      input_tokens, output_tokens, cached_tokens, reasoning_tokens
    ) VALUES (
      'customendpoint', 'trace-customendpoint', 'chat gpt-5-nano',
      1783373827000, 1783373828000, 'chat', 'github', 'customendpoint-db-session',
      'customendpoint/gpt-5-nano', 'gpt-5-nano-2025-08-07', 1000, 100, 400, NULL
    );
    INSERT INTO span_attributes (span_id, key, value)
    VALUES ('customendpoint', 'copilot_chat.copilot_usage_nano_aiu', '0');
  `);
  db.close();

  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions.length, 1);
  const m = sessions[0];
  assert.equal(m.model, 'gpt-5-nano-2025-08-07');
  assert.equal(m.accessMode, 'byok');
  assert.equal(m.provider, 'custom');
  assert.equal(m.costSource, 'estimated');
  assert.ok(m.costUsd > 0);
});

test('copilot OTel: positive Copilot credits conflicting with BYOK stay unpriced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-copilot-otel-customendpoint-conflict-'));
  const path = join(root, 'copilot-otel.jsonl');
  writeFileSync(path, JSON.stringify({
    _spanContext: { traceId: 'trace-conflict', spanId: 'span-conflict' },
    startTime: [1783373827, 0],
    duration: [1, 0],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.conversation.id': 'customendpoint-conflict-session',
      'gen_ai.request.model': 'customendpoint/gpt-5-nano',
      'gen_ai.response.model': 'gpt-5-nano-2025-08-07',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'copilot_chat.copilot_usage_nano_aiu': 1000000000,
    },
  }) + '\n');

  const sessions = await copilotOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions[0].accessMode, 'mixed');
  assert.equal(sessions[0].provider, 'custom');
  assert.equal(sessions[0].costUsd, null);
});

test('copilot CLI OTel: parent/child calls count tokens once and root credits once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-cli-otel-'));
  const path = join(root, 'copilot-otel.jsonl');
  const attrs = (entries) => Object.entries(entries).map(([key, value]) => ({
    key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
  }));
  const span = (spanId, parentSpanId, start, attributes) => ({
    traceId: 'trace-1', spanId, parentSpanId, startTimeUnixNano: String(start * 1e6),
    endTimeUnixNano: String((start + 100) * 1e6), attributes: attrs(attributes),
  });
  const rows = [
    span('root', '', 1783373827000, {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'cli-session',
      'github.copilot.nano_aiu': 1000000000,
    }),
    span('subagent', 'root', 1783373827010, {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'child-session',
      'github.copilot.nano_aiu': 1000000000,
    }),
    span('chat-1', 'subagent', 1783373827020, {
      'gen_ai.operation.name': 'chat', 'gen_ai.conversation.id': 'child-session',
      'gen_ai.provider.name': 'github', 'gen_ai.response.model': 'gpt-5.6-luna',
      'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 30, 'gen_ai.usage.cache_creation.input_tokens': 5,
      'github.copilot.nano_aiu': 1000000000, 'server.address': 'api.githubcopilot.com',
    }),
  ];
  writeFileSync(path, JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: rows }] }] }) + '\n');
  const sessions = await copilotCliOtelParser.parseFile(path);
  assert.ok(sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'cli-session');
  assert.equal(sessions[0].tokens.input, 65);
  assert.equal(sessions[0].tokens.cacheRead, 30);
  assert.equal(sessions[0].tokens.cacheWrite, 5);
  assert.equal(sessions[0].costUsd, 0.01);
  assert.equal(sessions[0].costSource, 'actual');
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

test('claude: response speed prices each request and advisor independently, including cache TTL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-claude-speed-'));
  const file = join(root, 'speed.jsonl');
  const usage = { input_tokens: 100_000, output_tokens: 10_000,
    cache_read_input_tokens: 50_000, cache_creation_input_tokens: 3,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3 } };
  const record = (id, u, model = 'claude-opus-5-5') => ({
    type: 'assistant', timestamp: '2026-10-06T00:00:00Z', sessionId: 'speed',
    speed: 'fast', // Requested speed must not override the actual response speed.
    message: { id, model, usage: u },
  });
  writeFileSync(file, [
    record('a', { ...usage, speed: 'fast' }),
    record('a', { ...usage, speed: 'fast' }), // duplicate must be counted once
    record('b', { ...usage, speed: 'standard', iterations: [
      { type: 'advisor_message', model: 'claude-opus-5', ...usage, speed: 'fast' },
    ] }),
  ].map(JSON.stringify).join('\n'));
  const row = await claudeParser.parseFile(file);
  // Opus 5.5: .610024 standard, 1.220048 fast; advisor Opus 5: 1.55006 fast.
  assert.ok(Math.abs(row.costUsd - 3.380132) < 1e-12);
  assert.equal(row.estimated, false);
  assert.equal(row.tokens.cacheWrite, 9, 'stored counts remain actual, not TTL-equivalent tokens');

  for (const speed of [undefined, null, 'future-speed']) {
    writeFileSync(file, JSON.stringify(record('c', { ...usage, speed })));
    const estimated = await claudeParser.parseFile(file);
    assert.ok(Math.abs(estimated.costUsd - 0.610024) < 1e-12);
    assert.equal(estimated.estimated, true);
  }
  writeFileSync(file, JSON.stringify(record('d', { ...usage, speed: 'fast' }, 'claude-sonnet-5')));
  assert.equal((await claudeParser.parseFile(file)).costUsd, null, 'unsupported fast pricing is not guessed');
  writeFileSync(file, JSON.stringify(record('e', { ...usage, speed: 'standard' }, 'claude-opus-4-6')));
  assert.equal((await claudeParser.parseFile(file)).estimated, false, 'reported standard fallback is authoritative');
});
