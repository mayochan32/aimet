import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
  assert.throws(() => reportRows(fakeStore, { by: 'access' }), /invalid --by/);
  assert.throws(() => reportRows(fakeStore, { by: 'provider' }), /invalid --by/);
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
      'gpt-5': [9, 8, 7, 0], // valid override of a built-in prefix
      'bad-shape': ['x', 2, 3], // invalid -> skipped
      __proto__: [9, 9, 9, 9], // unsafe key -> skipped
    })
  );
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home; // homedir() uses USERPROFILE on Windows
    const { pricingTable, costUsd } = await import('../dist/pricing.js');
    const t = pricingTable();
    assert.deepEqual(t['my-model'], [1, 2, 0.1, 0], 'valid override accepted');
    assert.deepEqual(t['gpt-5'], [9, 8, 7, 0], 'built-in entry overridden');
    assert.equal('bad-shape' in t, false, 'invalid entry skipped');
    assert.equal(
      costUsd('copilot/auto', {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null,
      }),
      0,
      'explicit zero usage costs $0 even when the model is unknown'
    );
    assert.equal(
      costUsd('nonexistent-model', {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      }),
      null,
      'non-zero usage still needs a matching price'
    );
    assert.equal(
      costUsd('nonexistent-model', {
        input: 0, output: 0, cacheRead: null, cacheWrite: 0, reasoning: null,
      }),
      null,
      'an unrecorded field must not be mistaken for measured zero'
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
  }
});
