import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  billsCacheWrites,
  costUsd,
  hasLongContextSurcharge,
  pricingTable,
} from '../dist/pricing.js';

const usage = (overrides = {}) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...overrides,
});

test('pricing: current Claude 5 and corrected Opus 4 rates match official pricing', () => {
  const prices = pricingTable();
  assert.deepEqual(prices['claude-fable-5'], [10, 50, 1, 12.5]);
  assert.deepEqual(prices['claude-mythos-5'], [10, 50, 1, 12.5]);
  assert.deepEqual(prices['claude-opus-5'], [5, 25, 0.5, 6.25]);
  assert.deepEqual(prices['claude-sonnet-5'], [2, 10, 0.2, 2.5]);
  assert.deepEqual(prices['claude-opus-4-8'], [5, 25, 0.5, 6.25]);
  assert.equal(costUsd('claude-sonnet-5', usage({ input: 1_000_000 })), 2);
  assert.equal(costUsd('claude-opus-5-20260724', usage({ output: 1_000_000 })), 25);
});

test('pricing: GPT-5.4 through GPT-5.6 use current exact model rates', () => {
  assert.equal(costUsd('gpt-5.4-mini', usage({ input: 1_000_000 })), 0.75);
  assert.equal(costUsd('gpt-5.4', usage({ output: 1_000_000 })), 15);
  assert.equal(costUsd('gpt-5.5', usage({ input: 100_000 })), 0.5);
  assert.equal(costUsd('gpt-5.6', usage({ output: 1_000_000 })), 20);
  assert.equal(costUsd('gpt-5.6-sol', usage({ input: 100_000 })), 0.4);
  assert.equal(costUsd('gpt-5.6-terra', usage({ input: 100_000 })), 0.2);
  assert.equal(costUsd('gpt-5.6-luna', usage({ input: 100_000 })), 0.02);
  assert.equal(costUsd('gpt-5.6-cyber', usage({ output: 1_000_000 })), 75);
  assert.equal(billsCacheWrites('gpt-5.6-sol'), true);
  assert.equal(costUsd('gpt-5.6-sol', usage({ cacheWrite: 100_000 })), 0.5);
});

test('pricing: long-context requests apply official input and output multipliers', () => {
  assert.equal(hasLongContextSurcharge('gpt-5.6-terra'), true);
  assert.equal(
    costUsd('gpt-5.6-terra', usage({ input: 273_000, output: 1_000 })),
    (273_000 * 2 * 2 + 1_000 * 12 * 1.5) / 1e6
  );
  assert.equal(
    costUsd('gpt-5.6-terra', usage({ input: 272_000, output: 1_000 })),
    (272_000 * 2 + 1_000 * 12) / 1e6
  );
});

test('pricing: an unknown future model never inherits an older built-in family rate', () => {
  assert.equal(costUsd('gpt-5.7', usage({ input: 1000 })), null);
  assert.equal(costUsd('claude-opus-4-9', usage({ input: 1000 })), null);
});
