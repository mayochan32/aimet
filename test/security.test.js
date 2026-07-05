import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fx = (name) => join(import.meta.dirname, 'fixtures', name);

test('copilot: crafted __proto__ path does not pollute Object.prototype', async () => {
  const { reduceSession } = await import('../dist/parsers/copilot.js');
  const s = await reduceSession(fx('copilot-pollute.jsonl'));
  assert.equal({}.polluted, undefined, 'prototype must not be polluted');
  assert.equal({}.x, undefined);
  // legitimate data survives
  assert.ok(Array.isArray(s.requests));
  assert.equal(s.requests.length, 1);
});

test('copilot: pollution fixture still parses to a valid session', async () => {
  const { copilotParser } = await import('../dist/parsers/copilot.js');
  const m = await copilotParser.parseFile(fx('copilot-pollute.jsonl'));
  assert.ok(m);
  assert.equal(m.turns, 1);
});

test('report: rejects non-whitelisted --by before touching SQL', async () => {
  const { reportRows } = await import('../dist/report.js');
  const fakeStore = { query: () => [] };
  assert.throws(
    () => reportRows(fakeStore, { by: 'tool; DROP TABLE sessions' }),
    /invalid --by/
  );
  assert.throws(() => reportRows(fakeStore, { period: 'yearly' }), /invalid --period/);
  // valid values pass through
  assert.doesNotThrow(() => reportRows(fakeStore, { by: 'model', period: 'weekly' }));
});

test('pricing: invalid user entries are ignored, defaults preserved', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aimet-price-'));
  mkdirSync(join(home, '.aimet'), { recursive: true });
  writeFileSync(
    join(home, '.aimet', 'pricing.json'),
    JSON.stringify({
      'my-model': [1, 2, 0.1, 0], // valid
      'bad-shape': ['x', 2, 3], // invalid -> skipped
      __proto__: [9, 9, 9, 9], // unsafe key -> skipped
    })
  );
  process.env.HOME = home;
  const { pricingTable, costUsd } = await import('../dist/pricing.js');
  const t = pricingTable();
  assert.deepEqual(t['my-model'], [1, 2, 0.1, 0], 'valid override accepted');
  assert.equal('bad-shape' in t, false, 'invalid entry skipped');
  assert.equal(costUsd('nonexistent-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }), null);
});

test('init: refuses to overwrite an invalid config file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aimet-init-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  const broken = '{ not valid json, // comment\n';
  writeFileSync(settings, broken);
  process.env.HOME = home;
  const { initTool } = await import('../dist/init.js');
  assert.throws(() => initTool('claude', false), /not valid JSON/);
  assert.equal(readFileSync(settings, 'utf8'), broken, 'file must be left untouched');
});
