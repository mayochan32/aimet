import type { Store } from './store.js';

export interface ReportOpts {
  period?: 'daily' | 'weekly' | 'monthly';
  by?: 'tool' | 'project' | 'model';
  tool?: string;
  model?: string;
  sinceDays?: number;
  /** inclusive range on started_at; ISO strings (see parseTimeArg) */
  startISO?: string;
  endISO?: string;
  json?: boolean;
}

export interface SessionsOpts {
  tool?: string;
  id?: string;
  sinceDays?: number;
  startISO?: string;
  endISO?: string;
  /** Undefined means --all; otherwise a positive integer up to 1000. */
  limit?: number;
}

/**
 * Parse a LOCAL-time stamp "YYYYMMDD[hh[mm[ss]]]" into an ISO(UTC) string.
 * Missing trailing parts default to the start of the unit; pass end=true to
 * default to the END of the unit instead (23:59:59 etc.), so that
 * --start 20260701 --end 20260707 covers the whole final day.
 */
export function parseTimeArg(s: string, end = false): string {
  const digits = s.replace(/[^0-9]/g, '');
  if (!/^\d{8}(\d{2}){0,3}$/.test(digits)) {
    throw new Error(`invalid time "${s}" (expected YYYYMMDD[hh[mm[ss]]])`);
  }
  const pad = end ? ['23', '59', '59'] : ['00', '00', '00'];
  const hh = digits.slice(8, 10) || pad[0];
  const mm = digits.slice(10, 12) || pad[1];
  const ss = digits.slice(12, 14) || pad[2];
  const d = new Date(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(hh),
    Number(mm),
    Number(ss)
  );
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time "${s}"`);
  return d.toISOString();
}

const num = (v: unknown) => Number(v ?? 0);

// Whitelists for values that get interpolated into SQL (never parameterized
// as column names). Reject anything outside the known set.
const GROUP_COLUMNS = new Set(['tool', 'project', 'model']);
const PERIODS = new Set(['daily', 'weekly', 'monthly']);
const TOOLS = new Set(['claude', 'codex', 'copilot', 'copilot-cli']);

/** ISO timestamp -> local human time "YYYY-MM-DD HH:mm:ss (+09:00)". */
export function fmtLocal(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymdhms = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${ymdhms} (${sign}${hh}:${mm})`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** Token cell renderer: null/undefined = "not recorded" -> '-'. */
export function tok(v: unknown): string {
  return v == null ? '-' : fmtTokens(Number(v));
}

export function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(2) + 'h';
}

/**
 * Columns that identify one report row. Model names are not globally unique
 * accounting keys: the same model used through Copilot has Copilot credit
 * semantics, while direct Claude/Codex usage uses API-equivalent pricing.
 */
export function reportGroupColumns(
  by?: ReportOpts['by'],
  tool?: string,
  model?: string
): Array<'tool' | 'project' | 'model'> {
  const columns: Array<'tool' | 'project' | 'model'> = [];
  if (tool || model || by === 'tool' || by === 'model') columns.push('tool');
  if (model) columns.push('model');
  if (by && !columns.includes(by)) columns.push(by);
  return columns;
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
  const groupColumns = reportGroupColumns(opts.by, opts.tool, opts.model);
  const group = groupColumns.map((column) => `, s.${column}`).join('');
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceDays) {
    conds.push(`s.started_at >= datetime('now', '-${Math.floor(opts.sinceDays)} days')`);
  }
  if (opts.tool) {
    conds.push('s.tool = ?');
    params.push(opts.tool);
  }
  if (opts.model) {
    conds.push('s.model = ?');
    params.push(opts.model);
  }
  if (opts.startISO) {
    conds.push('s.started_at >= ?');
    params.push(opts.startISO);
  }
  if (opts.endISO) {
    conds.push('s.started_at <= ?');
    params.push(opts.endISO);
  }
  // A tree-scoped parent already includes descendants. Exclude its child rows
  // from period totals, while own-scoped VS Code parents are added to children.
  conds.push(`NOT EXISTS (
    SELECT 1 FROM sessions parent
    WHERE parent.tool = s.tool
      AND parent.session_id = s.parent_session_id
      AND parent.metric_scope = 'tree'
  )`);
  const where = `WHERE ${conds.join(' AND ')}`;

  return store.query(
    `SELECT ${bucket} AS period${group},
       MIN(started_at) AS started_at,
       MAX(last_event_at) AS last_event_at,
       COUNT(*) AS sessions,
       SUM(turns) AS turns,
       SUM(duration_sec) AS duration_sec,
       SUM(active_sec) AS active_sec,
       CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input,
       CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output,
       CASE WHEN COUNT(cache_read_tokens) = COUNT(*) THEN SUM(cache_read_tokens) END AS cache_read,
       CASE WHEN COUNT(cache_write_tokens) = COUNT(*) THEN SUM(cache_write_tokens) END AS cache_write,
       CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) END AS cost_usd,
       MAX(estimated) AS estimated
     FROM sessions AS s ${where}
     GROUP BY period${group}
     ORDER BY period DESC${groupColumns.map((column) => `, ${column}`).join('')}`,
    ...params
  );
}

export function report(store: Store, opts: ReportOpts = {}): string {
  const rows = reportRows(store, opts);
  if (opts.json) return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return 'No data. Run `aimet collect` first.';

  const groupColumns = reportGroupColumns(opts.by, opts.tool, opts.model);
  const header = ['period', 'start', 'last', ...groupColumns, 'sess', 'turns', 'active', 'wall', 'in', 'out', 'cacheR', 'cacheW', 'cost($)'];
  const lines = rows.map((r) => [
    String(r.period),
    fmtLocal(r.started_at),
    fmtLocal(r.last_event_at),
    ...groupColumns.map((column) => column === 'model'
      ? String(r[column])
      : String(r[column]).slice(0, 28)),
    String(r.sessions),
    String(r.turns),
    fmtHours(num(r.active_sec)),
    fmtHours(num(r.duration_sec)),
    tok(r.input),
    tok(r.output),
    tok(r.cache_read),
    tok(r.cache_write),
    r.cost_usd == null ? '-' : num(r.cost_usd).toFixed(2) + (num(r.estimated) ? '*' : ''),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padStart(widths[i])).join('  ');
  return [fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n') +
    '\n\n( * = includes estimated values | Claude/Codex: API-equivalent USD | ' +
    'Copilot actual: AI Credits x $0.01; estimated/mixed rows may include API-equivalent estimates | ' +
    'Copilot CLI: cost unavailable )' +
    '\nコストは参考値。実際の実行環境に合わせて計算してください。';
}

/** Filtered session metadata and total count before the display limit. */
export function sessionsRows(
  store: Store,
  opts: SessionsOpts = { limit: 50 }
): { rows: Record<string, unknown>[]; total: number } {
  if (opts.tool && !TOOLS.has(opts.tool)) {
    throw new Error(`invalid --tool value: ${opts.tool} (expected claude | codex | copilot | copilot-cli)`);
  }
  if (opts.sinceDays !== undefined &&
      (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0)) {
    throw new Error('invalid --since value (expected a positive number)');
  }
  if (opts.limit !== undefined &&
      (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000)) {
    throw new Error('invalid --limit value (expected an integer from 1 to 1000)');
  }
  if (opts.startISO && opts.endISO && opts.startISO > opts.endISO) {
    throw new Error('--start must not be later than --end');
  }

  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.tool) { conds.push('tool = ?'); params.push(opts.tool); }
  if (opts.id) { conds.push('session_id LIKE ?'); params.push(`${opts.id}%`); }
  if (opts.sinceDays !== undefined) {
    const cutoff = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
    conds.push('started_at >= ?');
    params.push(cutoff);
  }
  if (opts.startISO) { conds.push('started_at >= ?'); params.push(opts.startISO); }
  if (opts.endISO) { conds.push('started_at <= ?'); params.push(opts.endISO); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const totalRow = store.query(`SELECT COUNT(*) AS total FROM sessions ${where}`, ...params)[0];
  const limit = opts.limit === undefined ? '' : ` LIMIT ${opts.limit}`;
  const rows = store.query(
    `SELECT tool, session_id, parent_session_id,
            CASE WHEN parent_session_id IS NULL THEN 'session' ELSE 'subagent' END AS kind,
            model, started_at, last_event_at, turns
     FROM sessions ${where}
     ORDER BY started_at DESC, tool ASC, session_id ASC${limit}`,
    ...params
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/** Human-readable session-id listing. */
export function sessionsList(
  store: Store,
  opts: SessionsOpts = { limit: 50 }
): string {
  const { rows, total } = sessionsRows(store, opts);
  if (rows.length === 0) {
    return 'No sessions found. Run `aimet collect` first or change the filters.';
  }
  const blocks = rows.map((r) => {
    const lines = [
      `${fmtLocal(r.started_at)} -> ${fmtLocal(r.last_event_at)} | ` +
        `${r.tool} | ${r.kind} | ${r.model}`,
      `  id     : ${r.session_id}`,
    ];
    if (r.parent_session_id != null) lines.push(`  parent : ${r.parent_session_id}`);
    return lines.join('\n');
  });
  return [
    ...blocks,
    `showing ${rows.length} of ${total} matching sessions`,
    'last means the last observed event, not confirmed completion',
  ].join('\n\n');
}

/** Cost semantics differ per tool: see README "コスト計算の仕組み". */
export function costLabel(r: Record<string, unknown>): string {
  if (r.tool === 'copilot') {
    // Actual spend: also show the raw credit amount (1 credit = $0.01 fixed),
    // since Copilot budgets/dashboards are denominated in credits.
    const source = String(r.cost_source ?? (num(r.estimated) ? 'estimated' : 'actual'));
    if (source === 'actual') {
      return ` (actual, ${(num(r.cost_usd) * 100).toFixed(2)} Copilot credits)`;
    }
    return source === 'mixed'
      ? ' (mixed actual + API-equivalent estimate)'
      : ' (API-equivalent, estimated)';
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
  // A Claude child id starts with its parent id
  // (<parent>/agent-<id>). Preserve abbreviated-id lookup, but when the user
  // supplies a complete parent id, select that exact row before newer children.
  const exactOrder = opts.id ? 'CASE WHEN session_id = ? THEN 0 ELSE 1 END,' : '';
  if (opts.id) params.push(opts.id);
  const rows = store.query(
    `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${exactOrder} last_event_at DESC LIMIT 1`,
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
    `SELECT COUNT(*) AS n,
            CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input,
            CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output,
            CASE WHEN COUNT(cache_read_tokens) = COUNT(*) THEN SUM(cache_read_tokens) END AS cache_read,
            CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) END AS cost_usd,
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

function childSessionLabel(childId: unknown, parentId: unknown): string {
  const child = String(childId);
  const prefix = `${String(parentId)}/`;
  // Claude's collision-free DB key embeds the parent id. Show the meaningful
  // agent portion instead of truncating every child to the same parent prefix.
  return child.startsWith(prefix) ? child.slice(prefix.length) : child.slice(0, 24);
}

type RollupField = 'turns' | 'active_sec' | 'duration_sec' | 'input_tokens' |
  'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'reasoning_tokens' | 'cost_usd';

/** One canonical parent/child rollup used by text and Markdown session views. */
export function rollupSessionRows(
  root: Record<string, unknown>,
  children: Record<string, unknown>[]
): Record<string, unknown> {
  const includedChildren = root.metric_scope === 'tree' ? [] : children;
  const rows = [root, ...includedChildren];
  const total: Record<string, unknown> = {
    tool: root.tool,
    sessions: rows.length,
    estimated: rows.some((r) => num(r.estimated) > 0) ? 1 : 0,
    children_included: includedChildren.length,
  };
  const partial: string[] = [];
  const fields: RollupField[] = [
    'turns', 'active_sec', 'duration_sec', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost_usd',
  ];
  for (const field of fields) {
    const known = rows.filter((r) => r[field] != null);
    total[field] = known.length === rows.length
      ? known.reduce((sum, r) => sum + num(r[field]), 0)
      : null;
    if (known.length < rows.length) partial.push(field);
  }
  const sources = new Set(rows.map((r) => String(r.cost_source ?? (num(r.estimated) ? 'estimated' : 'actual'))));
  total.cost_source = sources.size === 1 ? [...sources][0] : 'mixed';
  total.partial_fields = partial;
  return total;
}

/** Human summary for one session (used by `aimet session` / skills). */
export function sessionSummary(store: Store, opts: { tool?: string; id?: string }): string {
  const r = sessionRow(store, opts);
  if (!r) return 'Session not found.';
  const kids = childrenRollup(store, r.session_id);
  const kidRows = kids ? childrenRows(store, r.session_id) : [];
  const total = rollupSessionRows(r, kidRows);
  const kidSources = new Set(kidRows.map((k) => String(k.cost_source ?? (num(k.estimated) ? 'estimated' : 'actual'))));
  const kidCostMeta: Record<string, unknown> = {
    tool: r.tool,
    cost_usd: kids?.cost_usd,
    cost_source: kidSources.size === 1 ? [...kidSources][0] : 'mixed',
    estimated: kidRows.some((k) => num(k.estimated) > 0) ? 1 : 0,
  };
  const kidLines = kids
    ? [
        `subagents (${kids.n}):`,
        ...kidRows.map(
          (k) =>
            `  - ${childSessionLabel(k.session_id, r.session_id)}  ${String(k.model)}  ` +
            `turns ${k.turns} / in ${tok(k.input_tokens)} / out ${tok(k.output_tokens)} / ` +
            `cacheR ${tok(k.cache_read_tokens)} / ` +
            `${k.cost_usd == null ? 'cost n/a' : '$' + num(k.cost_usd).toFixed(4) + costLabel(k)}`
        ),
        `subagents total: turns ${kids.turns} / in ${tok(kids.input)} / out ${tok(kids.output)} / cacheR ${tok(kids.cache_read)} / ` +
          (kids.cost_usd == null
            ? 'cost n/a'
            : `cost +$${num(kids.cost_usd).toFixed(4)}${costLabel(kidCostMeta)}`) +
          (kidRows.some((k) => k.cost_usd == null)
            ? ` ※${kidRows.filter((k) => k.cost_usd == null).length}件のコストが取得不可のため合計もn/a`
            : ''),
        rootTotalLine(r, total, kidRows.length),
      ]
    : [];
  const parentLine = r.parent_session_id ? [`parent  : ${r.parent_session_id}`] : [];
  return [
    `session : ${r.tool} ${r.session_id}`,
    ...parentLine,
    `project : ${r.project}`,
    `model   : ${r.model}`,
    `time    : ${fmtLocal(r.started_at)} -> ${fmtLocal(r.last_event_at)} ` +
      `(active ${fmtHours(num(r.active_sec))} / wall ${fmtHours(num(r.duration_sec))})`,
    `turns   : ${r.turns}`,
    `tokens  : in ${tok(r.input_tokens)} / out ${tok(r.output_tokens)} / cacheR ${tok(r.cache_read_tokens)} / cacheW ${tok(r.cache_write_tokens)}`,
    `cost    : ${r.cost_usd == null ? noCostLabel(r) : '$' + num(r.cost_usd).toFixed(4) + costLabel(r)}`,
    ...kidLines,
    '',
    'コストは参考値。実際の実行環境に合わせて計算してください。',
  ].join('\n');
}

function rootTotalLine(
  root: Record<string, unknown>,
  total: Record<string, unknown>,
  childCount: number
): string {
  const scopeNote = root.metric_scope === 'tree'
    ? `parent already includes ${childCount} subagents`
    : `parent + ${childCount} subagents`;
  const cost = total.cost_usd == null ? 'n/a' : `$${num(total.cost_usd).toFixed(4)}${costLabel(total)}`;
  return `TOTAL(${scopeNote}): in ${tok(total.input_tokens)} / out ${tok(total.output_tokens)} / ` +
    `cacheR ${tok(total.cache_read_tokens)} / cost ${cost}`;
}
