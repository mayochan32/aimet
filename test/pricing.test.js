import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  billsCacheWrites,
  costUsd,
  copilotCostUsd,
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

test('pricing: deprecated GPT-5.1 Codex variants retain their official historical rates', () => {
  assert.deepEqual(pricingTable()['gpt-5.1-codex-max'], [1.25, 10, 0.125, 0]);
  assert.deepEqual(pricingTable()['gpt-5.1-codex-mini'], [0.25, 2, 0.025, 0]);
  assert.equal(costUsd('gpt-5.1-codex-max', usage({ input: 1_000_000 })), 1.25);
  assert.equal(costUsd('gpt-5.1-codex-mini', usage({ output: 1_000_000 })), 2);
  assert.equal(
    costUsd('gpt-5.1-codex-max-20251119', usage({ cacheRead: 1_000_000 })),
    0.125
  );
  assert.equal(costUsd('gpt-5.1-codex-max-plus', usage({ input: 1_000 })), null);
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

test('pricing: GPT-6, dated GPT-5 nano, and separate Copilot rates', () => {
  assert.deepEqual(pricingTable()['gpt-6-astra'], [10, 50, 1, 12.5]);
  assert.equal(costUsd('gpt-5-nano-2025-08-07', usage({ input: 1_000_000 })), 0.05);
  assert.equal(costUsd('gpt-6-astra', usage({ input: 273_000, output: 1_000 })),
    (273_000 * 10 * 2 + 1_000 * 50 * 1.5) / 1e6);
  assert.equal(copilotCostUsd('gpt-5.2-codex', usage({ input: 1_000_000 })), 1.75);
  assert.equal(copilotCostUsd('gpt-6-astra', usage({ input: 1_000_000 })), 20);
  assert.equal(copilotCostUsd('gpt-6-unknown', usage({ input: 1_000 })), null);
});

test('pricing: September models price every token class and dated snapshots', () => {
  const models = [
    ['gpt-6-sol', [2, 10, 0.2, 2.5]],
    ['gpt-6-luna', [0.1, 0.5, 0.01, 0.125]],
    ['gpt-6.1-sol', [2, 10, 0.1, 2.5]],
    ['claude-opus-5-5', [4, 20, 0.2, 5]],
    ['claude-opus-5.5', [4, 20, 0.2, 5]],
    ['claude-sonnet-5-5', [2, 10, 0.2, 2.5]],
    ['claude-sonnet-5.5', [2, 10, 0.2, 2.5]],
  ];
  for (const [model, rates] of models) {
    for (const id of [model, `${model}-20261001`]) {
      for (const [i, field] of ['input', 'output', 'cacheRead', 'cacheWrite'].entries()) {
        const tokens = usage({ [field]: 100_000 });
        assert.equal(costUsd(id, tokens), rates[i] / 10, `${id}: ${field}`);
        assert.equal(copilotCostUsd(id, tokens), rates[i] / 10, `Copilot ${id}: ${field}`);
      }
    }
    assert.equal(costUsd(`${model}-future`, usage({ input: 1 })), null);
    assert.equal(copilotCostUsd(`${model}-future`, usage({ input: 1 })), null);
  }
});

test('pricing: new GPT models count cache tokens toward the 272K boundary', () => {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']) {
    assert.equal(billsCacheWrites(`${model}-20261001`), true);
    assert.equal(hasLongContextSurcharge(`${model}-20261001`), true);
    const [input, output, read, write] = pricingTable()[model];
    for (const price of [costUsd, copilotCostUsd]) {
      assert.equal(price(model, usage({ input: 200_000, cacheRead: 70_000,
        cacheWrite: 2_000, output: 1_000 })),
      (200_000 * input + 70_000 * read + 2_000 * write + 1_000 * output) / 1e6);
      assert.equal(price(model, usage({ input: 200_000, cacheRead: 70_000,
        cacheWrite: 2_001, output: 1_000 })),
      ((200_000 * input + 70_000 * read + 2_001 * write) * 2 + 1_000 * output * 1.5) / 1e6);
    }
  }
  assert.equal(billsCacheWrites('gpt-6.2-sol'), false);
  assert.equal(costUsd('gpt-6.2-sol', usage({ input: 1 })), null);
});

test('pricing: Copilot Grok 4.7 doubles input and output only above 200K', () => {
  assert.equal(copilotCostUsd('grok-4.7', usage({ input: 100_000, cacheRead: 100_000,
    output: 1_000 })), 0.256);
  assert.equal(copilotCostUsd('grok-4.7-20261001', usage({ input: 100_001, cacheRead: 100_000,
    output: 1_000 })), 0.512004);
  assert.equal(costUsd('grok-4.7', usage({ input: 1_000 })), null, 'GitHub rates are not BYOK rates');
});
