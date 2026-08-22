import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../dist/store.js';
import { collect } from '../dist/collect.js';
import { reportRows, rollupSessionRows, sessionSummary } from '../dist/report.js';
import { sessionMd } from '../dist/markdown.js';
import { copilotParser } from '../dist/parsers/copilot.js';
import { copilotSubagentParser } from '../dist/parsers/copilotsubagent.js';

function sampleMetrics(overrides = {}) {
  return {
    tool: 'claude',
    sessionId: 'sess-1',
    logPath: '/tmp/a.jsonl',
    project: '/proj',
    model: 'claude-sonnet-4-6',
    startedAt: '2026-06-01T00:00:00.000Z',
    endedAt: '2026-06-01T00:10:00.000Z',
    durationSec: 600,
    activeSec: 300,
    tokens: { input: 10, output: 20, cacheRead: 100, cacheWrite: 5, reasoning: 0 },
    costUsd: 0.01,
    estimated: false,
    turns: 3,
    lastEventAt: '2026-06-01T00:10:00.000Z',
    ...overrides,
  };
}

test('store: idempotent upsert (insert -> skip -> update)', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);

  assert.equal(store.upsert(sampleMetrics()), 'inserted');
  // same last_event_at -> stale -> skipped, no double counting
  assert.equal(store.upsert(sampleMetrics()), 'skipped');
  // newer event -> updated
  assert.equal(
    store.upsert(sampleMetrics({ lastEventAt: '2026-06-01T00:20:00.000Z', turns: 4 })),
    'updated'
  );

  const rows = store.query('SELECT COUNT(*) AS n, MAX(turns) AS t FROM sessions');
  assert.equal(rows[0].n, 1, 'exactly one row (no duplication)');
  assert.equal(rows[0].t, 4, 'row reflects the newer data');
  store.close();
});

test('store migration adds project provenance and allows an exact later upgrade', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const oldRow = sampleMetrics({
    tool: 'copilot', sessionId: 'migrated-project',
    logPath: '/x/GitHub.copilot-chat/debug-logs/migrated-project/main.jsonl',
    project: '/old/project', projectSource: 'structured-reference',
  });
  const raw = new DatabaseSync(db);
  raw.exec(`
    CREATE TABLE sessions (
      tool TEXT NOT NULL, session_id TEXT NOT NULL, log_path TEXT NOT NULL,
      project TEXT NOT NULL, model TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
      duration_sec INTEGER NOT NULL, active_sec INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL, cost_usd REAL,
      estimated INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL,
      last_event_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (tool, session_id)
    );
    INSERT INTO sessions VALUES (
      'copilot', 'migrated-project',
      '/x/GitHub.copilot-chat/debug-logs/migrated-project/main.jsonl',
      '/old/project', 'model',
      '2026-06-01T00:00:00.000Z', '2026-06-01T00:10:00.000Z',
      600, 300, 10, 20, 100, 5, 0, 0.01, 0, 3,
      '2026-06-01T00:10:00.000Z', '2026-06-01T00:10:00.000Z'
    );
  `);
  raw.close();

  const migrated = new Store(db);
  assert.equal(migrated.query(
    'SELECT project_source FROM sessions WHERE session_id = ?', 'migrated-project'
  )[0].project_source, 'legacy');
  assert.equal(migrated.upsert({
    ...oldRow,
    project: '/exact/project',
    projectSource: 'session-store',
  }), 'updated');
  assert.deepEqual({ ...migrated.query(
    'SELECT project, project_source FROM sessions WHERE session_id = ?', 'migrated-project'
  )[0] }, {
    project: '/exact/project',
    project_source: 'session-store',
  });
  migrated.close();
});

test('collect: re-running over the same logs skips everything (idempotent)', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  // Isolate a single claude log so other-tool fixtures don't get cross-parsed.
  const root = mkdtempSync(join(tmpdir(), 'aimet-logs-'));
  copyFileSync(
    join(import.meta.dirname, 'fixtures', 'claude-basic.jsonl'),
    join(root, 'claude-basic.jsonl')
  );
  const roots = [root];

  const first = await collect({ store, tools: ['claude'], roots, quiet: true });
  assert.equal(first.inserted, 1, 'first pass ingests the claude fixture');

  const second = await collect({ store, tools: ['claude'], roots, quiet: true });
  assert.equal(second.inserted, 0, 'second pass inserts nothing');
  assert.equal(second.updated, 0, 'second pass updates nothing');
  assert.equal(second.skipped, 1, 'second pass skips the previously ingested session');
  store.close();
});

test('collect: Claude parent and subagents remain distinct and roll up exactly once', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const root = join(import.meta.dirname, 'fixtures', 'claude-multi-agent');

  const first = await collect({ store, tools: ['claude'], roots: [root], quiet: true });
  assert.deepEqual(first, { scanned: 3, inserted: 3, updated: 0, skipped: 0, errors: 0 });

  const sessions = store.query(
    `SELECT session_id, parent_session_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens
       FROM sessions ORDER BY session_id`
  );
  assert.deepEqual(sessions.map((row) => ({ ...row })), [
    {
      session_id: 'parent-session', parent_session_id: null,
      input_tokens: 100, output_tokens: 10, cache_read_tokens: 50, cache_write_tokens: 5,
    },
    {
      session_id: 'parent-session/agent-alpha', parent_session_id: 'parent-session',
      input_tokens: 11, output_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2,
    },
    {
      session_id: 'parent-session/agent-beta', parent_session_id: 'parent-session',
      input_tokens: 13, output_tokens: 9, cache_read_tokens: 4, cache_write_tokens: 1,
    },
  ]);

  const report = reportRows(store, { tool: 'claude' });
  assert.equal(report[0].sessions, 3);
  assert.equal(report[0].input, 124);
  assert.equal(report[0].output, 26);
  assert.equal(report[0].cache_read, 57);
  assert.equal(report[0].cache_write, 8);
  const summary = sessionSummary(store, { tool: 'claude', id: 'parent-session' });
  assert.match(summary, /agent-alpha/);
  assert.match(summary, /agent-beta/);
  assert.match(summary, /TOTAL\(parent \+ 2 subagents\)/);

  const second = await collect({ store, tools: ['claude'], roots: [root], quiet: true });
  assert.deepEqual(second, { scanned: 3, inserted: 0, updated: 0, skipped: 3, errors: 0 });
  store.close();
});

test('store deterministically keeps Copilot main span over chat snapshot', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const chat = sampleMetrics({
    tool: 'copilot', sessionId: 'same-parent',
    logPath: '/x/chatSessions/same-parent.jsonl',
    project: '/known/workspace',
    lastEventAt: '2026-06-01T00:20:00.000Z',
    tokens: { input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: null },
  });
  const main = sampleMetrics({
    tool: 'copilot', sessionId: 'same-parent',
    logPath: '/x/GitHub.copilot-chat/debug-logs/same-parent/main.jsonl',
    project: 'unknown',
    lastEventAt: '2026-06-01T00:19:00.000Z',
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: null, reasoning: null },
  });
  assert.equal(store.upsert(chat), 'inserted');
  assert.equal(store.upsert(main), 'updated', 'richer main wins even with an earlier final timestamp');
  assert.equal(store.upsert(chat), 'skipped', 'later scan cannot replace main with chat');
  const row = store.query('SELECT log_path, project, input_tokens, cache_read_tokens FROM sessions')[0];
  assert.match(String(row.log_path), /debug-logs/);
  assert.equal(row.project, '/known/workspace', 'richer metrics preserve known chat project');
  assert.equal(row.input_tokens, 100);
  assert.equal(row.cache_read_tokens, 50);
  store.close();
});

test('lower-ranked Copilot chat snapshot enriches an existing main project only', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const main = sampleMetrics({
    tool: 'copilot', sessionId: 'reverse-parent',
    logPath: '/x/GitHub.copilot-chat/debug-logs/reverse-parent/main.jsonl',
    project: 'unknown',
    lastEventAt: '2026-06-01T00:19:00.000Z',
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: null, reasoning: null },
  });
  const chat = sampleMetrics({
    tool: 'copilot', sessionId: 'reverse-parent',
    logPath: '/x/chatSessions/reverse-parent.jsonl',
    project: '/known/reverse-workspace',
    lastEventAt: '2026-06-01T00:20:00.000Z',
    tokens: { input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: null },
  });

  assert.equal(store.upsert(main), 'inserted');
  assert.equal(store.upsert(chat), 'updated', 'chat contributes only missing project metadata');
  const row = store.query(
    'SELECT log_path, project, input_tokens, cache_read_tokens FROM sessions'
  )[0];
  assert.match(String(row.log_path), /debug-logs/);
  assert.equal(row.project, '/known/reverse-workspace');
  assert.equal(row.input_tokens, 100, 'main metrics are retained');
  assert.equal(row.cache_read_tokens, 50);
  assert.equal(store.upsert(chat), 'skipped', 'project enrichment remains idempotent');
  store.close();
});

test('higher-confidence project evidence replaces an earlier heuristic without touching metrics', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const base = sampleMetrics({
    tool: 'copilot', sessionId: 'project-upgrade',
    logPath: '/x/GitHub.copilot-chat/debug-logs/project-upgrade/main.jsonl',
    project: '/heuristic/project-a', projectSource: 'structured-reference',
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: null, reasoning: null },
  });

  assert.equal(store.upsert(base), 'inserted');
  const child = sampleMetrics({
    tool: 'copilot', sessionId: 'project-upgrade-child', parentSessionId: 'project-upgrade',
    logPath: '/x/GitHub.copilot-chat/debug-logs/project-upgrade/runSubagent-child.jsonl',
    project: 'unknown',
    tokens: { input: 30, output: 5, cacheRead: 10, cacheWrite: null, reasoning: null },
  });
  assert.equal(store.upsert(child), 'inserted');
  assert.equal(store.upsert({
    ...base,
    project: '/exact/project-b',
    projectSource: 'session-store',
    tokens: { input: 999, output: 999, cacheRead: 999, cacheWrite: null, reasoning: null },
  }), 'updated');

  const row = store.query(
    `SELECT project, project_source, input_tokens, output_tokens, cache_read_tokens
     FROM sessions WHERE session_id = 'project-upgrade'`
  )[0];
  assert.deepEqual({ ...row }, {
    project: '/exact/project-b',
    project_source: 'session-store',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 50,
  }, 'metadata-only upgrade preserves the previously accepted metrics');
  const childRow = store.query(
    `SELECT project, project_source, input_tokens FROM sessions
     WHERE session_id = 'project-upgrade-child'`
  )[0];
  assert.deepEqual({ ...childRow }, {
    project: '/exact/project-b',
    project_source: 'parent',
    input_tokens: 30,
  }, 'children inherited from the parent are upgraded without touching metrics');
  store.close();
});

test('lower-confidence project evidence cannot replace an exact project', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const exact = sampleMetrics({
    tool: 'copilot', sessionId: 'project-no-downgrade',
    logPath: '/x/GitHub.copilot-chat/debug-logs/project-no-downgrade/main.jsonl',
    project: '/exact/project', projectSource: 'session-store',
  });
  assert.equal(store.upsert(exact), 'inserted');
  assert.equal(store.upsert({
    ...exact,
    project: '/heuristic/project', projectSource: 'structured-reference',
    lastEventAt: '2026-06-01T00:20:00.000Z',
  }), 'updated', 'newer metrics may update the row');
  const row = store.query('SELECT project, project_source FROM sessions')[0];
  assert.deepEqual({ ...row }, {
    project: '/exact/project',
    project_source: 'session-store',
  });
  store.close();
});

test('Copilot children inherit a known parent project in either scan order', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const parent = sampleMetrics({
    tool: 'copilot', sessionId: 'project-parent', project: '/workspace/project',
    logPath: '/x/GitHub.copilot-chat/debug-logs/project-parent/main.jsonl',
  });
  const earlyChild = sampleMetrics({
    tool: 'copilot', sessionId: 'early-child', parentSessionId: 'project-parent',
    project: 'unknown', logPath: '/x/GitHub.copilot-chat/debug-logs/project-parent/runSubagent-early.jsonl',
  });
  const lateChild = sampleMetrics({
    tool: 'copilot', sessionId: 'late-child', parentSessionId: 'project-parent',
    project: 'unknown', logPath: '/x/GitHub.copilot-chat/debug-logs/project-parent/runSubagent-late.jsonl',
  });

  store.upsert(earlyChild);
  store.upsert(parent);
  store.upsert(lateChild);
  const rows = store.query(
    `SELECT session_id, project FROM sessions
     WHERE parent_session_id = 'project-parent' ORDER BY session_id`
  );
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { session_id: 'early-child', project: '/workspace/project' },
    { session_id: 'late-child', project: '/workspace/project' },
  ]);
  store.close();
});

test('copilot own-scoped parent and children are added exactly once in every view', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  const parent = sampleMetrics({
    tool: 'copilot', sessionId: 'parent-own', costUsd: 0.01,
    tokens: { input: 100, output: 10, cacheRead: null, cacheWrite: null, reasoning: null },
    metricScope: 'own', costSource: 'actual',
  });
  const child = sampleMetrics({
    tool: 'copilot', sessionId: 'child-own', parentSessionId: 'parent-own', costUsd: 0.02,
    tokens: { input: 200, output: 20, cacheRead: 50, cacheWrite: null, reasoning: null },
    metricScope: 'own', costSource: 'actual',
  });
  store.upsert(parent);
  store.upsert(child);

  const report = reportRows(store);
  assert.equal(report[0].sessions, 2);
  assert.equal(report[0].input, 300);
  assert.equal(report[0].cost_usd, 0.03);

  const root = store.query('SELECT * FROM sessions WHERE session_id = ?', 'parent-own')[0];
  const kids = store.query('SELECT * FROM sessions WHERE parent_session_id = ?', 'parent-own');
  const total = rollupSessionRows(root, kids);
  assert.equal(total.input_tokens, 300);
  assert.equal(total.output_tokens, 30);
  assert.equal(total.cost_usd, 0.03);
  assert.match(sessionSummary(store, { tool: 'copilot', id: 'parent-own' }), /cost \$0\.0300/);
  assert.match(sessionMd(root, kids), /\$0\.0300/);
  store.close();
});

test('tree-scoped parent prevents descendant double counting', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  store.upsert(sampleMetrics({
    tool: 'copilot', sessionId: 'parent-tree', costUsd: 0.03,
    tokens: { input: 300, output: 30, cacheRead: 50, cacheWrite: null, reasoning: null },
    metricScope: 'tree', costSource: 'actual',
  }));
  store.upsert(sampleMetrics({
    tool: 'copilot', sessionId: 'child-under-tree', parentSessionId: 'parent-tree', costUsd: 0.02,
    tokens: { input: 200, output: 20, cacheRead: 50, cacheWrite: null, reasoning: null },
    metricScope: 'own', costSource: 'actual',
  }));

  const report = reportRows(store);
  assert.equal(report[0].sessions, 1);
  assert.equal(report[0].input, 300);
  assert.equal(report[0].cost_usd, 0.03);
  const root = store.query('SELECT * FROM sessions WHERE session_id = ?', 'parent-tree')[0];
  const kids = store.query('SELECT * FROM sessions WHERE parent_session_id = ?', 'parent-tree');
  const total = rollupSessionRows(root, kids);
  assert.equal(total.input_tokens, 300);
  assert.equal(total.cost_usd, 0.03);
  assert.equal(total.children_included, 0);
  store.close();
});

test('partial token or cost data never appears as a complete aggregate', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  store.upsert(sampleMetrics({
    tool: 'copilot', sessionId: 'partial-parent', costUsd: 0.01,
    tokens: { input: 100, output: 10, cacheRead: 20, cacheWrite: null, reasoning: null },
    metricScope: 'own', costSource: 'actual',
  }));
  store.upsert(sampleMetrics({
    tool: 'copilot', sessionId: 'partial-child', parentSessionId: 'partial-parent', costUsd: null,
    tokens: { input: null, output: 20, cacheRead: null, cacheWrite: null, reasoning: null },
    metricScope: 'own', costSource: 'estimated',
  }));

  const report = reportRows(store)[0];
  assert.equal(report.input, null);
  assert.equal(report.output, 30);
  assert.equal(report.cost_usd, null);
  const root = store.query('SELECT * FROM sessions WHERE session_id = ?', 'partial-parent')[0];
  const kids = store.query('SELECT * FROM sessions WHERE parent_session_id = ?', 'partial-parent');
  const total = rollupSessionRows(root, kids);
  assert.equal(total.input_tokens, null);
  assert.equal(total.output_tokens, 30);
  assert.equal(total.cost_usd, null);
  assert.deepEqual(total.partial_fields.sort(), [
    'cache_read_tokens',
    'cache_write_tokens',
    'cost_usd',
    'input_tokens',
    'reasoning_tokens',
  ]);
  const summary = sessionSummary(store, { tool: 'copilot', id: 'partial-parent' });
  assert.match(summary, /subagents total:.*cost n\/a/);
  assert.match(summary, /TOTAL\(parent \+ 1 subagents\):.*cost n\/a/);
  assert.doesNotMatch(summary, /subagents total:.*\+\$0\.0000/);
  store.close();
});

test('sanitized real Copilot golden session preserves parent, four children and exact AIC', async () => {
  const parent = await copilotParser.parseFile(
    join(import.meta.dirname, 'fixtures', 'real', 'copilot-golden-parent.jsonl')
  );
  assert.ok(parent);
  assert.equal(parent.tokens.input, 13470);
  assert.equal(parent.tokens.cacheRead, 90112);
  assert.equal(parent.tokens.output, 2166);
  assert.equal(parent.costUsd, 0.02233386);

  const children = [];
  for (let i = 1; i <= 4; i++) {
    const child = await copilotSubagentParser.parseFile(
      join(import.meta.dirname, 'fixtures', 'real', `copilot-golden-child-${i}.jsonl`)
    );
    assert.ok(child);
    children.push(child);
  }
  assert.equal(children.reduce((sum, c) => sum + c.tokens.input, 0), 122107);
  assert.equal(children.reduce((sum, c) => sum + c.tokens.cacheRead, 0), 415232);
  assert.equal(children.reduce((sum, c) => sum + c.tokens.output, 0), 21653);
  assert.equal(children.reduce((sum, c) => sum + c.costUsd, 0), 0.198145035);

  const db = join(mkdtempSync(join(tmpdir(), 'aimet-db-')), 'm.db');
  const store = new Store(db);
  store.upsert(parent);
  for (const child of children) store.upsert(child);
  const rows = reportRows(store, { tool: 'copilot' });
  assert.equal(rows[0].sessions, 5);
  assert.equal(rows[0].input, 135577);
  assert.equal(rows[0].cache_read, 505344);
  assert.equal(rows[0].output, 23819);
  assert.ok(Math.abs(rows[0].cost_usd - 0.220478895) < 1e-12);
  assert.match(sessionSummary(store, { tool: 'copilot', id: 'golden-parent' }), /cost \$0\.2205/);
  store.close();
});
