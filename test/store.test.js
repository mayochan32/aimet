import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Store } from '../dist/store.js';
import { collect } from '../dist/collect.js';

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
