import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { GAP_THRESHOLD_MS } from '../types.js';

/** Stream a JSONL file line by line; malformed lines are skipped. */
export async function* jsonlRecords(path: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      /* tolerate partial/corrupt lines */
    }
  }
}

/** Active seconds: sum of consecutive-event gaps below the idle threshold. */
export function activeSeconds(timestamps: string[]): number {
  const ts = timestamps
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= GAP_THRESHOLD_MS) ms += gap;
  }
  return Math.round(ms / 1000);
}

export function durationSeconds(first: string, last: string): number {
  const d = (Date.parse(last) - Date.parse(first)) / 1000;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
}
