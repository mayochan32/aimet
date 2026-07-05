import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TokenUsage } from './types.js';

/**
 * USD per 1M tokens: [input, output, cacheRead, cacheWrite].
 * Overridable via ~/.aimet/pricing.json (same shape, merged over defaults).
 * Matching is by prefix, longest prefix wins.
 */
const DEFAULT_PRICING: Record<string, [number, number, number, number]> = {
  // Anthropic
  'claude-opus-4': [15, 75, 1.5, 18.75],
  'claude-sonnet-4': [3, 15, 0.3, 3.75],
  'claude-haiku-4': [1, 5, 0.1, 1.25],
  'claude-3-5-haiku': [0.8, 4, 0.08, 1],
  // OpenAI (cacheWrite not billed separately -> 0)
  'gpt-5.2-codex': [1.75, 14, 0.175, 0],
  'gpt-5.1-codex': [1.25, 10, 0.125, 0],
  'gpt-5-codex': [1.25, 10, 0.125, 0],
  'gpt-5.2': [1.75, 14, 0.175, 0],
  'gpt-5.1': [1.25, 10, 0.125, 0],
  'gpt-5-mini': [0.25, 2, 0.025, 0],
  'gpt-5': [1.25, 10, 0.125, 0],
  'o4-mini': [1.1, 4.4, 0.275, 0],
};

let cached: Record<string, [number, number, number, number]> | null = null;

export function pricingTable(): Record<string, [number, number, number, number]> {
  if (cached) return cached;
  cached = { ...DEFAULT_PRICING };
  const userFile = join(homedir(), '.aimet', 'pricing.json');
  if (existsSync(userFile)) {
    try {
      Object.assign(cached, JSON.parse(readFileSync(userFile, 'utf8')));
    } catch {
      /* ignore malformed user pricing */
    }
  }
  return cached;
}

/** API-equivalent cost in USD, or null when the model is unknown. */
export function costUsd(model: string, t: TokenUsage): number | null {
  const table = pricingTable();
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const [inP, outP, crP, cwP] = table[key];
  return (
    (t.input * inP + t.output * outP + t.cacheRead * crP + t.cacheWrite * cwP) / 1e6
  );
}
