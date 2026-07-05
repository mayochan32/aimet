import type { Store } from './store.js';

export interface ReportOpts {
  period?: 'daily' | 'weekly' | 'monthly';
  by?: 'tool' | 'project' | 'model';
  tool?: string;
  sinceDays?: number;
  json?: boolean;
}

const num = (v: unknown) => Number(v ?? 0);

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(2) + 'h';
}

/** Aggregated rows for a report (shared by text/JSON/Markdown renderers). */
export function reportRows(store: Store, opts: ReportOpts = {}): Record<string, unknown>[] {
  const period = opts.period ?? 'daily';
  // Bucket by LOCAL date (the machine's timezone), not UTC.
  const local = "datetime(started_at, 'localtime')";
  const bucket =
    period === 'daily'
      ? `substr(${local}, 1, 10)`
      : period === 'monthly'
        ? `substr(${local}, 1, 7)`
        : `strftime('%Y-W%W', ${local})`;
  const group = opts.by ? `, ${opts.by}` : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceDays) {
    conds.push(`started_at >= datetime('now', '-${Math.floor(opts.sinceDays)} days')`);
  }
  if (opts.tool) {
    conds.push('tool = ?');
    params.push(opts.tool);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  return store.query(
    `SELECT ${bucket} AS period${group},
       MIN(started_at) AS first_start,
       MAX(ended_at) AS last_end,
       COUNT(*) AS sessions,
       SUM(turns) AS turns,
       SUM(duration_sec) AS duration_sec,
       SUM(active_sec) AS active_sec,
       SUM(input_tokens) AS input,
       SUM(output_tokens) AS output,
       SUM(cache_read_tokens) AS cache_read,
       SUM(cache_write_tokens) AS cache_write,
       SUM(cost_usd) AS cost_usd,
       MAX(estimated) AS estimated
     FROM sessions ${where}
     GROUP BY period${group}
     ORDER BY period DESC${group ? `, ${opts.by}` : ''}`,
    ...params
  );
}

export function report(store: Store, opts: ReportOpts = {}): string {
  const rows = reportRows(store, opts);
  if (opts.json) return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return 'No data. Run `aimet collect` first.';

  const header = ['period', ...(opts.by ? [opts.by] : []), 'sess', 'turns', 'active', 'wall', 'in', 'out', 'cacheR', 'cacheW', 'cost($)'];
  const lines = rows.map((r) => [
    String(r.period),
    ...(opts.by ? [String(r[opts.by!]).slice(0, 28)] : []),
    String(r.sessions),
    String(r.turns),
    fmtHours(num(r.active_sec)),
    fmtHours(num(r.duration_sec)),
    fmtTokens(num(r.input)),
    fmtTokens(num(r.output)),
    fmtTokens(num(r.cache_read)),
    fmtTokens(num(r.cache_write)),
    r.cost_usd == null ? '-' : num(r.cost_usd).toFixed(2) + (num(r.estimated) ? '*' : ''),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padStart(widths[i])).join('  ');
  return [fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n') +
    '\n\n( * = includes estimated values | cost: claude/codex = API-equivalent USD, copilot = actual credit spend )';
}

/** Cost semantics differ per tool: see README "コスト計算の仕組み". */
export function costLabel(r: Record<string, unknown>): string {
  if (r.tool === 'copilot') {
    return num(r.estimated) ? ' (API-equivalent, estimated)' : ' (actual, Copilot credits)';
  }
  return ' (API-equivalent)';
}

/** Latest matching session row, or null. */
export function sessionRow(
  store: Store,
  opts: { tool?: string; id?: string }
): Record<string, unknown> | null {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.tool) { where.push('tool = ?'); params.push(opts.tool); }
  if (opts.id) { where.push('session_id LIKE ?'); params.push(opts.id + '%'); }
  const rows = store.query(
    `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ended_at DESC LIMIT 1`,
    ...params
  );
  return rows[0] ?? null;
}

/** Human summary for one session (used by `aimet session` / skills). */
export function sessionSummary(store: Store, opts: { tool?: string; id?: string }): string {
  const r = sessionRow(store, opts);
  if (!r) return 'Session not found.';
  return [
    `session : ${r.tool} ${r.session_id}`,
    `project : ${r.project}`,
    `model   : ${r.model}`,
    `time    : ${r.started_at} -> ${r.ended_at} (active ${fmtHours(num(r.active_sec))} / wall ${fmtHours(num(r.duration_sec))})`,
    `turns   : ${r.turns}`,
    `tokens  : in ${fmtTokens(num(r.input_tokens))} / out ${fmtTokens(num(r.output_tokens))} / cacheR ${fmtTokens(num(r.cache_read_tokens))} / cacheW ${fmtTokens(num(r.cache_write_tokens))}`,
    `cost    : ${r.cost_usd == null ? 'unknown model' : '$' + num(r.cost_usd).toFixed(4) + costLabel(r)}`,
  ].join('\n');
}
