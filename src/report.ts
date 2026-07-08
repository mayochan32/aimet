import type { Store } from './store.js';

export interface ReportOpts {
  period?: 'daily' | 'weekly' | 'monthly';
  by?: 'tool' | 'project' | 'model';
  tool?: string;
  sinceDays?: number;
  json?: boolean;
}

const num = (v: unknown) => Number(v ?? 0);

// Whitelists for values that get interpolated into SQL (never parameterized
// as column names). Reject anything outside the known set.
const GROUP_COLUMNS = new Set(['tool', 'project', 'model']);
const PERIODS = new Set(['daily', 'weekly', 'monthly']);

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
  if (opts.by && !GROUP_COLUMNS.has(opts.by)) {
    throw new Error(`invalid --by value: ${opts.by} (expected tool | project | model)`);
  }
  const period = opts.period ?? 'daily';
  if (!PERIODS.has(period)) {
    throw new Error(`invalid --period value: ${period} (expected daily | weekly | monthly)`);
  }
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
    '\n\n( * = includes estimated values | cost: claude/codex = API-equivalent USD, copilot = actual credit spend )' +
    '\nコストは参考値。実際の実行環境に合わせて計算してください。';
}

/** Cost semantics differ per tool: see README "コスト計算の仕組み". */
export function costLabel(r: Record<string, unknown>): string {
  if (r.tool === 'copilot') {
    return num(r.estimated) ? ' (API-equivalent, estimated)' : ' (actual, Copilot credits)';
  }
  return ' (API-equivalent)';
}

/** Why a session has no cost. Copilot CLI logs no input tokens; others = unknown model. */
export function noCostLabel(r: Record<string, unknown>): string {
  return r.tool === 'copilot-cli'
    ? 'n/a (Copilot CLI records no input tokens)'
    : 'unknown model';
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

/** Aggregate of subagent (child) sessions for a parent, or null. */
export function childrenRollup(
  store: Store,
  sessionId: unknown
): Record<string, unknown> | null {
  const rows = store.query(
    `SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(cache_read_tokens) AS cache_read, SUM(cost_usd) AS cost_usd,
            SUM(turns) AS turns
     FROM sessions WHERE parent_session_id = ?`,
    sessionId
  );
  return rows.length && Number(rows[0].n) > 0 ? rows[0] : null;
}

/** Child (subagent) session rows for a parent, newest first. */
export function childrenRows(store: Store, sessionId: unknown): Record<string, unknown>[] {
  return store.query(
    `SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at`,
    sessionId
  );
}

/** Human summary for one session (used by `aimet session` / skills). */
export function sessionSummary(store: Store, opts: { tool?: string; id?: string }): string {
  const r = sessionRow(store, opts);
  if (!r) return 'Session not found.';
  const kids = childrenRollup(store, r.session_id);
  const kidRows = kids ? childrenRows(store, r.session_id) : [];
  const kidLines = kids
    ? [
        `subagents (${kids.n}):`,
        ...kidRows.map(
          (k) =>
            `  - ${String(k.session_id).slice(0, 24)}  ${String(k.model)}  ` +
            `turns ${k.turns} / in ${fmtTokens(num(k.input_tokens))} / out ${fmtTokens(num(k.output_tokens))} / ` +
            `cacheR ${fmtTokens(num(k.cache_read_tokens))} / ` +
            `${k.cost_usd == null ? 'cost n/a' : '$' + num(k.cost_usd).toFixed(4) + (num(k.estimated) ? '*' : '')}`
        ),
        `subagents total: turns ${kids.turns} / in ${fmtTokens(num(kids.input))} / out ${fmtTokens(num(kids.output))} / cacheR ${fmtTokens(num(kids.cache_read))} / cost +$${num(kids.cost_usd).toFixed(4)} (API-equivalent, estimated)`,
        `TOTAL(with subagents): cost $${(num(r.cost_usd) + num(kids.cost_usd)).toFixed(4)}`,
      ]
    : [];
  const parentLine = r.parent_session_id ? [`parent  : ${r.parent_session_id}`] : [];
  return [
    `session : ${r.tool} ${r.session_id}`,
    ...parentLine,
    `project : ${r.project}`,
    `model   : ${r.model}`,
    `time    : ${r.started_at} -> ${r.ended_at} (active ${fmtHours(num(r.active_sec))} / wall ${fmtHours(num(r.duration_sec))})`,
    `turns   : ${r.turns}`,
    `tokens  : in ${fmtTokens(num(r.input_tokens))} / out ${fmtTokens(num(r.output_tokens))} / cacheR ${fmtTokens(num(r.cache_read_tokens))} / cacheW ${fmtTokens(num(r.cache_write_tokens))}`,
    `cost    : ${r.cost_usd == null ? noCostLabel(r) : '$' + num(r.cost_usd).toFixed(4) + costLabel(r)}`,
    ...kidLines,
    '',
    'コストは参考値。実際の実行環境に合わせて計算してください。',
  ].join('\n');
}
