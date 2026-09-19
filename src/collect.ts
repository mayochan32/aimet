import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { Parser, SessionMetrics } from './types.js';
import { parsers } from './parsers/index.js';
import { Store } from './store.js';

function* walk(dir: string): Generator<string> {
  try {
    if (statSync(dir).isFile()) {
      yield dir;
      return;
    }
  } catch {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export interface CollectResult {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

/** Scan default log dirs (or explicit roots) and ingest sessions. */
export async function collect(opts: {
  store: Store;
  tools?: string[];
  roots?: string[]; // override scan roots (used by tests / --dir)
  sinceDays?: number;
  quiet?: boolean;
}): Promise<CollectResult> {
  const res: CollectResult = { scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };
  const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86400_000 : 0;
  const active = parsers.filter((p) => !opts.tools || opts.tools.includes(p.tool));

  for (const parser of active) {
    const roots = opts.roots ?? parser.defaultDirs().map((d) => isAbsolute(d) ? d : join(homedir(), d));
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!parser.isLogFile(file)) continue;
        if (cutoff && statSync(file).mtimeMs < cutoff) continue;
        res.scanned++;
        try {
          const parsed = await parser.parseFile(file);
          if (!parsed) continue;
          const metrics = Array.isArray(parsed) ? parsed : [parsed];
          for (const m of metrics) {
            res[opts.store.upsert(m) as 'inserted' | 'updated' | 'skipped']++;
          }
        } catch (err) {
          res.errors++;
          if (!opts.quiet) console.error(`aimet: failed to parse ${file}: ${err}`);
        }
      }
    }
  }
  return res;
}

/** Ingest one specific log file with a given parser. */
export async function ingestFile(
  store: Store,
  parser: Parser,
  path: string
): Promise<SessionMetrics | SessionMetrics[] | null> {
  const parsed = await parser.parseFile(path);
  if (!parsed) return null;
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) store.upsert(m);
  return parsed;
}
