import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

test('price overrides preserve built-in billing conditions and Codex estimation', async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), 'aimet-override-'));
  t.mock.method(os, 'homedir', () => root);
  syncBuiltinESMExports();
  try {
    mkdirSync(join(root, '.aimet'));
    writeFileSync(join(root, '.aimet/pricing.json'), JSON.stringify({
      'gpt-6.1-sol-20260929': [3, 15, 0.2, 4],
      'claude-opus-5-5-20260922': [5, 25, 0.3, 6.25],
      'gpt-6': [1, 2, 0.1, 0],
    }));
    const { costUsd, claudeCostUsd, hasLongContextSurcharge, billsCacheWrites } = await import('../dist/pricing.js');
    const model = 'gpt-6.1-sol-20260929';
    const tokens = { input: 300_000, output: 1_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    assert.equal(hasLongContextSurcharge(model), true);
    assert.equal(billsCacheWrites(model), true);
    assert.equal(costUsd(model, tokens), 1.8225);
    assert.equal(hasLongContextSurcharge('gpt-6-future'), false);
    assert.equal(billsCacheWrites('gpt-6-future'), false);
    assert.equal(costUsd('gpt-6-future', tokens), 0.302, 'user prefixes still set prices');
    assert.deepEqual(claudeCostUsd('claude-opus-5-5-20260922', tokens, 'fast'),
      { cost: 3.05, estimated: false });

    const { codexParser } = await import('../dist/parsers/codex.js');
    const file = join(root, 'rollout-test.jsonl');
    for (const hasWrites of [true, false]) {
      const usage = { input_tokens: 300_000, cached_input_tokens: 0, output_tokens: 1_000,
        reasoning_output_tokens: 0, total_tokens: 301_000,
        ...(hasWrites ? { cache_write_input_tokens: 0 } : {}) };
      writeFileSync(file, [
        { timestamp: '2026-10-06T00:00:00Z', type: 'turn_context', payload: { model } },
        { timestamp: '2026-10-06T00:00:01Z', type: 'event_msg', payload: {
          type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage },
        } },
      ].map(JSON.stringify).join('\n'));
      const row = await codexParser.parseFile(file);
      assert.equal(row.costUsd, hasWrites ? 1.8225 : 0.915);
      assert.equal(row.estimated, !hasWrites);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
