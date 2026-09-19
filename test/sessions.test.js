import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Store } from '../dist/store.js';
import { report, reportRows, sessionsList, sessionsRows, otelNotice } from '../dist/report.js';
import { reportMd, sessionsMd } from '../dist/markdown.js';

const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');

function metrics(id, startedAt, lastEventAt, overrides = {}) {
  return {
    tool: 'codex',
    sessionId: id,
    logPath: `/logs/${id}.jsonl`,
    project: '/project',
    model: 'gpt-5.6-sol',
    startedAt,
    lastEventAt,
    durationSec: (Date.parse(lastEventAt) - Date.parse(startedAt)) / 1000,
    activeSec: 10,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0 },
    costUsd: 0.001,
    estimated: false,
    turns: 1,
    ...overrides,
  };
}

function populatedDb() {
  const root = mkdtempSync(join(tmpdir(), 'aimet-sessions-'));
  const db = join(root, 'metrics.db');
  const store = new Store(db);
  store.upsert(metrics(
    'parent-session-full-id',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:10:00.000Z'
  ));
  store.upsert(metrics(
    'child-session-full-id',
    '2026-08-25T01:00:00.000Z',
    '2026-08-25T01:05:00.000Z',
    { model: 'gpt-5.6-luna', parentSessionId: 'parent-session-full-id' }
  ));
  store.upsert(metrics(
    'claude-session-full-id',
    '2026-08-24T23:00:00.000Z',
    '2026-08-24T23:01:00.000Z',
    { tool: 'claude', model: 'claude-sonnet-5' }
  ));
  store.close();
  return { root, db };
}

test('sessions: lists full ids newest first and identifies parent/subagent rows', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  const result = sessionsRows(store, { limit: 2 });
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows.map((r) => r.session_id), [
    'child-session-full-id',
    'parent-session-full-id',
  ]);
  assert.equal(result.rows[0].kind, 'subagent');
  assert.equal(result.rows[0].parent_session_id, 'parent-session-full-id');
  assert.equal(result.rows[1].kind, 'session');
  assert.equal(result.rows[1].parent_session_id, null);
  assert.equal('ended_at' in result.rows[0], false);
  store.close();
});

test('Copilot OTel notice is scoped to legacy sources and absent from JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-otel-notice-'));
  const store = new Store(join(root, 'metrics.db'));
  const start = '2026-09-20T00:00:00.000Z';
  const last = '2026-09-20T00:00:10.000Z';
  store.upsert(metrics('legacy', start, last, {
    tool: 'copilot', logPath: '/logs/chatSessions/legacy.jsonl', model: 'gpt-5',
  }));
  assert.match(otelNotice(store, { tool: 'copilot' }), /dbSpanExporter.enabled/);
  assert.doesNotMatch(report(store, { tool: 'copilot', json: true }), /dbSpanExporter.enabled/);
  assert.equal(otelNotice(store, { tool: 'codex' }), '');
  store.upsert(metrics('otel', start, last, {
    tool: 'copilot', logPath: '/logs/agent-traces.db', model: 'gpt-5',
  }));
  assert.equal(otelNotice(store, { tool: 'copilot', model: 'other-model' }), '');
  store.close();
});

test('sessions: filters by tool, id and inclusive start/end', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  const byTool = sessionsRows(store, { tool: 'claude', limit: 50 });
  assert.equal(byTool.total, 1);
  assert.equal(byTool.rows[0].session_id, 'claude-session-full-id');

  const byId = sessionsRows(store, { id: 'child-', limit: 50 });
  assert.equal(byId.total, 1);
  assert.equal(byId.rows[0].kind, 'subagent');

  const byTime = sessionsRows(store, {
    startISO: '2026-08-25T00:00:00.000Z',
    endISO: '2026-08-25T00:00:00.000Z',
    limit: 50,
  });
  assert.equal(byTime.total, 1, 'time boundaries are inclusive on started_at');
  assert.equal(byTime.rows[0].session_id, 'parent-session-full-id');
  store.close();
});

test('sessions: validates filters and limits', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  assert.throws(() => sessionsRows(store, { tool: 'bad', limit: 50 }), /invalid --tool/);
  assert.throws(() => sessionsRows(store, { sinceDays: 0, limit: 50 }), /invalid --since/);
  assert.throws(() => sessionsRows(store, { limit: 0 }), /invalid --limit/);
  assert.throws(() => sessionsRows(store, { limit: 1001 }), /invalid --limit/);
  assert.throws(() => sessionsRows(store, {
    startISO: '2026-08-26T00:00:00.000Z',
    endISO: '2026-08-25T00:00:00.000Z',
    limit: 50,
  }), /--start must not be later/);
  store.close();
});

test('sessions: human and Markdown outputs explain last-observed semantics', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  const text = sessionsList(store, { tool: 'codex', limit: 1 });
  assert.match(text, /child-session-full-id/);
  assert.match(text, /parent-session-full-id/);
  assert.match(text, /codex \| subagent \| gpt-5\.6-luna/);
  assert.match(text, /showing 1 of 2 matching sessions/);
  assert.match(text, /last means the last observed event, not confirmed completion/);

  const result = sessionsRows(store, { tool: 'codex', limit: 1 });
  const md = sessionsMd(result.rows, result.total, ['tool=codex', 'limit=1']);
  assert.match(md, /\| start \| last \| tool \| kind \| session ID \| parent ID \| model \|/);
  assert.match(md, /Filters: tool=codex, limit=1/);
  assert.match(md, /終了確定を意味しない/);
  store.close();
});

test('report uses start/last names and local human timestamps', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  const rows = reportRows(store, { by: 'tool' });
  assert.ok(rows.length > 0);
  assert.equal('started_at' in rows[0], true);
  assert.equal('last_event_at' in rows[0], true);
  assert.equal('first_start' in rows[0], false);
  assert.equal('last_end' in rows[0], false);
  const text = report(store, { by: 'tool' });
  assert.match(text.split('\n')[0], /period\s+start\s+last\s+tool/);
  assert.match(text, /\([+-]\d{2}:\d{2}\)/);
  store.close();
});

test('report with --tool includes tool in text, JSON and Markdown', () => {
  const { db } = populatedDb();
  const store = new Store(db);
  const opts = { tool: 'codex' };
  const rows = reportRows(store, opts);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.tool === 'codex'));

  const text = report(store, opts);
  assert.match(text.split('\n')[0], /period\s+start\s+last\s+tool/);
  assert.match(text, /codex/);

  const json = JSON.parse(report(store, { ...opts, json: true }));
  assert.ok(json.every((r) => r.tool === 'codex'));

  const md = reportMd(rows, opts);
  assert.match(md, /\| period \| start \| last \| tool \|/);
  assert.match(md, /\| codex \|/);
  store.close();
});

test('report with --model filters exact model and keeps tools separate in every format', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-report-model-filter-'));
  const db = join(root, 'metrics.db');
  const store = new Store(db);
  const startedAt = '2026-08-25T00:00:00.000Z';
  const lastEventAt = '2026-08-25T00:01:00.000Z';
  for (const tool of ['codex', 'copilot']) {
    store.upsert(metrics(`${tool}-selected-model`, startedAt, lastEventAt, {
      tool, model: 'shared-model', costUsd: tool === 'codex' ? 1 : 2,
    }));
  }
  store.upsert(metrics('codex-other-model', startedAt, lastEventAt, {
    model: 'other-model', costUsd: 3,
  }));

  const opts = { model: 'shared-model' };
  const rows = reportRows(store, opts);
  assert.deepEqual(rows.map((r) => [r.tool, r.model, r.cost_usd]), [
    ['codex', 'shared-model', 1],
    ['copilot', 'shared-model', 2],
  ]);

  const text = report(store, opts);
  assert.match(text.split('\n')[0], /period\s+start\s+last\s+tool\s+model/);
  assert.doesNotMatch(text, /other-model/);

  const json = JSON.parse(report(store, { ...opts, json: true }));
  assert.deepEqual(json.map((r) => [r.tool, r.model]), [
    ['codex', 'shared-model'],
    ['copilot', 'shared-model'],
  ]);

  const md = reportMd(rows, opts);
  assert.match(md, /\| period \| start \| last \| tool \| model \|/);

  store.close();
  const cliResult = spawnSync(process.execPath, [cli, 'report', '--model', 'shared-model', '--json'], {
    encoding: 'utf8', env: { ...process.env, AIMET_DB: db, TZ: 'UTC' },
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.deepEqual(JSON.parse(cliResult.stdout).map((r) => [r.tool, r.model]), [
    ['codex', 'shared-model'],
    ['copilot', 'shared-model'],
  ]);
});

test('report by model separates identical model names by tool in every format', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-report-model-'));
  const store = new Store(join(root, 'metrics.db'));
  const startedAt = '2026-08-25T00:00:00.000Z';
  const lastEventAt = '2026-08-25T00:01:00.000Z';
  store.upsert(metrics('codex-same-model', startedAt, lastEventAt, {
    tool: 'codex', model: 'shared-model-with-a-name-longer-than-28-characters', costUsd: 1,
  }));
  store.upsert(metrics('copilot-same-model', startedAt, lastEventAt, {
    tool: 'copilot', model: 'shared-model-with-a-name-longer-than-28-characters',
    accessMode: 'byok', provider: 'openai', costUsd: 2,
  }));

  const rows = reportRows(store, { by: 'model' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.tool, r.model, r.sessions, r.cost_usd]), [
    ['codex', 'shared-model-with-a-name-longer-than-28-characters', 1, 1],
    ['copilot', 'shared-model-with-a-name-longer-than-28-characters', 1, 2],
  ]);

  const text = report(store, { by: 'model' });
  assert.match(text.split('\n')[0], /period\s+start\s+last\s+tool\s+model/);
  assert.match(text, /codex\s+shared-model-with-a-name-longer-than-28-characters/);
  assert.match(text, /copilot\s+shared-model-with-a-name-longer-than-28-characters \[BYOK\/OpenAI\]/);

  const json = JSON.parse(report(store, { by: 'model', json: true }));
  assert.deepEqual(json.map((r) => [r.tool, r.model]), [
    ['codex', 'shared-model-with-a-name-longer-than-28-characters'],
    ['copilot', 'shared-model-with-a-name-longer-than-28-characters'],
  ]);

  const md = reportMd(rows, { by: 'model' });
  assert.match(md, /\| period \| start \| last \| tool \| model \|/);
  assert.match(md, /\| codex \| shared-model-with-a-name-longer-than-28-characters \|/);
  assert.match(md, /\| copilot \| shared-model-with-a-name-longer-than-28-characters \[BYOK\/OpenAI\] \|/);
  store.close();
});

test('report by model separates Copilot-hosted and BYOK uses of the same model', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-report-access-'));
  const store = new Store(join(root, 'metrics.db'));
  const startedAt = '2026-08-25T00:00:00.000Z';
  const lastEventAt = '2026-08-25T00:01:00.000Z';
  store.upsert(metrics('same-model-byok', startedAt, lastEventAt, {
    tool: 'copilot', model: 'gpt-5', accessMode: 'byok', provider: 'openai', costUsd: 1,
  }));
  store.upsert(metrics('same-model-copilot', startedAt, lastEventAt, {
    tool: 'copilot', model: 'gpt-5', accessMode: 'copilot', provider: 'github', costUsd: 2,
  }));

  const rows = reportRows(store, { by: 'model' });
  assert.deepEqual(rows.map((r) => [r.tool, r.access_mode, r.provider, r.model, r.cost_usd]), [
    ['copilot', 'byok', 'openai', 'gpt-5', 1],
    ['copilot', 'copilot', 'github', 'gpt-5', 2],
  ]);
  const text = report(store, { by: 'model' });
  assert.match(text, /gpt-5 \[BYOK\/OpenAI\]/);
  assert.doesNotMatch(text, /\[Copilot\]/);
  assert.match(text, /copilot\s+gpt-5\s+1\s+1/);
  const json = JSON.parse(report(store, { by: 'model', json: true }));
  assert.deepEqual(json.map((r) => [r.access_mode, r.provider, r.model]), [
    ['byok', 'openai', 'gpt-5'],
    ['copilot', 'github', 'gpt-5'],
  ]);
  store.close();
});

test('CLI sessions supports JSON, Markdown and rejects conflicting options', () => {
  const { root, db } = populatedDb();
  const env = { ...process.env, AIMET_DB: db, TZ: 'UTC' };
  const json = spawnSync(process.execPath, [cli, 'sessions', '--tool', 'codex', '--limit', '1', '--json'], {
    encoding: 'utf8', env,
  });
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), [
    'tool', 'session_id', 'parent_session_id', 'kind', 'model', 'access_mode', 'provider',
    'started_at', 'last_event_at', 'turns',
  ]);
  assert.equal(rows[0].started_at, '2026-08-25T01:00:00.000Z');
  assert.equal(rows[0].last_event_at, '2026-08-25T01:05:00.000Z');

  const human = spawnSync(process.execPath, [cli, 'sessions', '--id', 'child-', '--limit', '1'], {
    encoding: 'utf8', env: { ...env, TZ: 'Asia/Tokyo' },
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /2026-08-25 10:00:00 \(\+09:00\) -> 2026-08-25 10:05:00 \(\+09:00\)/);

  const mdPath = join(root, 'sessions.md');
  const md = spawnSync(process.execPath, [cli, 'sessions', '--all', '--md', mdPath], {
    encoding: 'utf8', env,
  });
  assert.equal(md.status, 0, md.stderr);
  assert.equal(md.stdout.trim(), `wrote ${mdPath}`);
  assert.match(readFileSync(mdPath, 'utf8'), /Showing 3 of 3 matching sessions/);

  for (const args of [
    ['sessions', '--all', '--limit', '2'],
    ['sessions', '--json', '--md', mdPath],
  ]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
    assert.equal(invalid.status, 1);
  }
});
