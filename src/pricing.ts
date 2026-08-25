import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TokenUsage } from './types.js';

/**
 * USD per 1M tokens: [input, output, cacheRead, cacheWrite].
 * Overridable via ~/.aimet/pricing.json (same shape, merged over defaults).
 * Built-ins match exact model IDs or dated snapshots. User overrides match by
 * prefix, with the longest matching key taking precedence.
 */
const DEFAULT_PRICING: Record<string, [number, number, number, number]> = {
  // Anthropic
  'claude-fable-5': [10, 50, 1, 12.5],
  'claude-mythos-5': [10, 50, 1, 12.5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-opus-4.8': [5, 25, 0.5, 6.25], // Copilot resolvedModel spelling
  'claude-opus-4-7': [5, 25, 0.5, 6.25],
  'claude-opus-4.7': [5, 25, 0.5, 6.25],
  'claude-opus-4-6': [5, 25, 0.5, 6.25],
  'claude-opus-4.6': [5, 25, 0.5, 6.25],
  'claude-opus-4-5': [5, 25, 0.5, 6.25],
  'claude-opus-4.5': [5, 25, 0.5, 6.25],
  'claude-opus-4-1': [15, 75, 1.5, 18.75],
  'claude-opus-4.1': [15, 75, 1.5, 18.75],
  'claude-opus-4': [15, 75, 1.5, 18.75],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4.6': [3, 15, 0.3, 3.75], // Copilot resolvedModel spelling
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-sonnet-4.5': [3, 15, 0.3, 3.75],
  'claude-sonnet-4': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-haiku-4.5': [1, 5, 0.1, 1.25], // Copilot resolvedModel spelling
  'claude-haiku-4': [1, 5, 0.1, 1.25],
  'claude-3-5-haiku': [0.8, 4, 0.08, 1],
  // OpenAI. GPT-5.6 explicit cache writes are billed at 1.25x input.
  'gpt-5.6-cyber': [12.5, 75, 1.25, 15.625],
  'gpt-5.6-terra': [2, 12, 0.2, 2.5],
  'gpt-5.6-luna': [0.2, 1.2, 0.02, 0.25],
  'gpt-5.6-sol': [4, 20, 0.4, 5],
  'gpt-5.6': [4, 20, 0.4, 5], // alias for GPT-5.6 Sol
  'gpt-5.5-pro': [30, 180, 30, 0], // no cached-input discount
  'gpt-5.5': [5, 30, 0.5, 0],
  'gpt-5.4-pro': [30, 180, 30, 0], // no cached-input discount
  'gpt-5.4-mini': [0.75, 4.5, 0.075, 0],
  'gpt-5.4-nano': [0.2, 1.25, 0.02, 0],
  'gpt-5.4': [2.5, 15, 0.25, 0],
  'gpt-5.3-codex': [1.75, 14, 0.175, 0],
  'gpt-5.3': [1.75, 14, 0.175, 0],
  'gpt-5.2-codex': [1.75, 14, 0.175, 0],
  'gpt-5.1-codex-mini': [0.25, 2, 0.025, 0],
  'gpt-5.1-codex-max': [1.25, 10, 0.125, 0],
  'gpt-5.1-codex': [1.25, 10, 0.125, 0],
  'gpt-5-codex': [1.25, 10, 0.125, 0],
  'gpt-5.2': [1.75, 14, 0.175, 0],
  'gpt-5.1': [1.25, 10, 0.125, 0],
  'gpt-5-mini': [0.25, 2, 0.025, 0],
  'gpt-5': [1.25, 10, 0.125, 0],
  'o4-mini': [1.1, 4.4, 0.275, 0],
};

let cached: Record<string, [number, number, number, number]> | null = null;
let userPrefixes = new Set<string>();

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** A valid entry is [input, output, cacheRead, cacheWrite] of 4 finite, non-negative numbers. */
function isValidRate(v: unknown): v is [number, number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  );
}

export function pricingTable(): Record<string, [number, number, number, number]> {
  if (cached) return cached;
  cached = { ...DEFAULT_PRICING };
  const userFile = join(homedir(), '.aimet', 'pricing.json');
  if (existsSync(userFile)) {
    try {
      const user = JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, unknown>;
      if (user === null || typeof user !== 'object' || Array.isArray(user)) {
        throw new Error('pricing.json must be a JSON object');
      }
      // Only accept well-formed entries; skip (and warn about) anything invalid
      // rather than letting a typo produce NaN costs.
      for (const [model, rate] of Object.entries(user)) {
        if (BLOCKED_KEYS.has(model)) continue;
        if (isValidRate(rate)) {
          cached[model] = rate;
          userPrefixes.add(model);
        }
        else console.error(`aimet: ignoring invalid pricing for "${model}" in ${userFile}`);
      }
    } catch (e) {
      console.error(`aimet: ignoring malformed ${userFile} (${(e as Error).message})`);
    }
  }
  return cached;
}

/**
 * Built-in prices match a canonical model id or its dated snapshot only.
 * This prevents a future gpt-5.7 from silently inheriting the gpt-5 rate.
 * User entries intentionally retain documented prefix matching semantics.
 */
function matchesPrice(model: string, key: string): boolean {
  if (model === key) return true;
  if (userPrefixes.has(key)) return model.startsWith(key);
  return model.startsWith(`${key}-20`);
}

function pricingKey(model: string): string | null {
  const key = Object.keys(pricingTable())
    .filter((candidate) => matchesPrice(model, candidate))
    .sort((a, b) => b.length - a.length)[0];
  return key ?? null;
}

const LONG_CONTEXT_MODELS = new Set([
  'gpt-5.4', 'gpt-5.4-pro',
  'gpt-5.5', 'gpt-5.5-pro',
  'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-cyber',
]);

/** Models whose requests above 272K input tokens use 2x input / 1.5x output. */
export function hasLongContextSurcharge(model: string): boolean {
  const key = pricingKey(model);
  return key !== null && LONG_CONTEXT_MODELS.has(key);
}

/** GPT-5.6 exposes and bills explicit cache-write input tokens. */
export function billsCacheWrites(model: string): boolean {
  const key = pricingKey(model);
  return key !== null && key.startsWith('gpt-5.6');
}

/** API-equivalent cost in USD, or null when a non-zero usage model is unknown. */
export function costUsd(
  model: string,
  t: TokenUsage,
  options: { applyLongContextSurcharge?: boolean } = {}
): number | null {
  // A request that failed before billing can retain a routing id such as
  // "copilot/auto", which intentionally has no price-table entry. When every
  // priced field is explicitly measured as zero, the cost is exactly $0 for
  // every possible unit price. Keep this strict: null means "not recorded"
  // and must not be converted into measured zero by this shortcut.
  if (t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0) {
    return 0;
  }
  const table = pricingTable();
  const key = pricingKey(model);
  if (!key) return null;
  const [inP, outP, crP, cwP] = table[key];
  const pricedInput = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  const longContext = options.applyLongContextSurcharge !== false &&
    hasLongContextSurcharge(model) && pricedInput > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  // null token fields mean "not recorded by the log" -> contribute 0 here.
  return (
    (((t.input ?? 0) * inP +
      (t.cacheRead ?? 0) * crP +
      (t.cacheWrite ?? 0) * cwP) * inputMultiplier +
      (t.output ?? 0) * outP * outputMultiplier) /
    1e6
  );
}
