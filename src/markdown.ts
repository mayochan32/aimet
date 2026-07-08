import { fmtTokens, fmtHours, costLabel } from './report.js';

/** Markdown renderers for the three output levels: report / session / detail. */

const num = (v: unknown) => Number(v ?? 0);
const esc = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|');

/** ISO timestamp -> local time "YYYY-MM-DD HH:mm:ss (+09:00)" (machine TZ). */
export function fmtLocal(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const ymdhms = d.toLocaleString('sv-SE'); // YYYY-MM-DD HH:mm:ss
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${ymdhms} (${sign}${hh}:${mm})`;
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

function kvTable(obj: Record<string, unknown>): string {
  return table(
    ['key', 'value'],
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === 'object' && v !== null ? '`' + JSON.stringify(v) + '`' : String(v),
    ])
  );
}

export function reportMd(
  rows: Record<string, unknown>[],
  opts: { period?: string; by?: string }
): string {
  const by = opts.by;
  const header = ['period', 'start', 'end', ...(by ? [by] : []), 'sessions', 'turns',
    'active', 'wall', 'input', 'output', 'cacheR', 'cacheW', 'cost($)'];
  const body = rows.map((r) => [
    String(r.period),
    fmtLocal(r.first_start),
    fmtLocal(r.last_end),
    ...(by ? [String(r[by])] : []),
    String(r.sessions),
    String(r.turns),
    fmtHours(num(r.active_sec)),
    fmtHours(num(r.duration_sec)),
    fmtTokens(num(r.input)),
    fmtTokens(num(r.output)),
    fmtTokens(num(r.cache_read)),
    fmtTokens(num(r.cache_write)),
    r.cost_usd == null ? '-' : num(r.cost_usd).toFixed(2) + (num(r.estimated) ? ' *' : ''),
  ]);
  return [
    `# AI Metrics Report (${opts.period ?? 'daily'}${by ? `, by ${by}` : ''})`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    table(header, body),
    '',
    '- active: 実働時間（5分超のアイドルを除外） / wall: 実時間',
    '- start / end: 期間内の最初のセッション開始・最後のセッション終了（ローカル時刻）',
    '- cost: API換算USD（`*` は推定値を含む）',
    '',
  ].join('\n');
}

export function sessionMd(
  r: Record<string, unknown>,
  children: Record<string, unknown>[] = []
): string {
  const childSection = children.length
    ? [
        '## Subagents',
        '',
        table(
          ['session', 'model', 'turns', 'in', 'out', 'cacheR', 'active', 'cost($)'],
          children.map((k) => [
            String(k.session_id),
            String(k.model),
            String(k.turns),
            fmtTokens(num(k.input_tokens)),
            fmtTokens(num(k.output_tokens)),
            fmtTokens(num(k.cache_read_tokens)),
            fmtHours(num(k.active_sec)),
            k.cost_usd == null ? '-' : num(k.cost_usd).toFixed(4) + (num(k.estimated) ? ' *' : ''),
          ])
        ),
        '',
        `**TOTAL (parent + subagents)**: $${(num(r.cost_usd) + children.reduce((s, k) => s + num(k.cost_usd), 0)).toFixed(4)}（子はAPI換算推定 \`*\`）`,
        '',
      ]
    : [];
  return [
    `# Session ${r.session_id}`,
    '',
    table(
      ['item', 'value'],
      [
        ['tool', String(r.tool)],
        ...(r.parent_session_id ? [['parent session', String(r.parent_session_id)] as [string, string]] : []),
        ['project', String(r.project)],
        ['model', String(r.model)],
        ['started', fmtLocal(r.started_at)],
        ['ended', fmtLocal(r.ended_at)],
        ['active / wall', `${fmtHours(num(r.active_sec))} / ${fmtHours(num(r.duration_sec))}`],
        ['turns', String(r.turns)],
        ['input tokens', num(r.input_tokens).toLocaleString()],
        ['output tokens', num(r.output_tokens).toLocaleString()],
        ['cache read', num(r.cache_read_tokens).toLocaleString()],
        ['cache write', num(r.cache_write_tokens).toLocaleString()],
        ['reasoning', num(r.reasoning_tokens).toLocaleString()],
        ['cost', r.cost_usd == null ? 'unknown model' : '$' + num(r.cost_usd).toFixed(4) + costLabel(r)],
        ['log file', String(r.log_path)],
      ]
    ),
    '',
    ...childSection,
  ].join('\n');
}

export function detailMd(d: Record<string, unknown>): string {
  const out: string[] = [`# Session Detail (${d.tool})`, '', `Log: \`${d.logPath}\``, ''];

  out.push('## Meta', '', kvTable((d.meta ?? {}) as Record<string, unknown>), '');
  out.push('## Models', '', (d.models as string[]).map((m) => `- ${m}`).join('\n') || '- (none)', '');
  out.push(
    '## Event counts',
    '',
    table(['event', 'count'],
      Object.entries(d.eventCounts as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, String(v)])),
    ''
  );

  if (d.tool === 'claude') {
    const reqs = d.requests as Record<string, unknown>[];
    out.push('## API requests', '');
    out.push(
      table(
        ['timestamp', 'model', 'stop', 'content', 'in', 'out', 'cacheR', 'cacheW(1h/5m)', 'tier'],
        reqs.map((q) => {
          const u = (q.usage ?? {}) as Record<string, unknown>;
          const cc = (u.cache_creation ?? {}) as Record<string, number>;
          return [
            String(q.timestamp),
            String(q.model ?? ''),
            String(q.stopReason ?? ''),
            (q.contentTypes as string[]).join(', '),
            String(u.input_tokens ?? 0),
            String(u.output_tokens ?? 0),
            String(u.cache_read_input_tokens ?? 0),
            `${u.cache_creation_input_tokens ?? 0} (${cc.ephemeral_1h_input_tokens ?? 0}/${cc.ephemeral_5m_input_tokens ?? 0})`,
            String(u.service_tier ?? ''),
          ];
        })
      ),
      ''
    );
  }

  if (d.tool === 'copilot' && d.format === 'span') {
    const reqs = d.requests as Record<string, unknown>[];
    out.push('## LLM requests (subagent span trace)', '');
    out.push(
      table(
        ['timestamp', 'model', 'debugName', 'in', 'cached', 'out', 'ttft', 'dur'],
        reqs.map((q) => [
          fmtLocal(String(q.timestamp)),
          String(q.model ?? ''),
          String(q.debugName ?? ''),
          String(q.inputTokens ?? '-'),
          String(q.cachedTokens ?? '-'),
          String(q.outputTokens ?? '-'),
          q.ttftMs == null ? '-' : String(q.ttftMs) + 'ms',
          q.durMs == null ? '-' : (Number(q.durMs) / 1000).toFixed(1) + 's',
        ])
      ),
      ''
    );
  } else if (d.tool === 'copilot') {
    const reqs = d.requests as Record<string, unknown>[];
    out.push('## Requests', '');
    out.push(
      table(
        ['timestamp', 'model', 'prompt', 'in', 'out', 'credits', 'elapsed', 'tool rounds'],
        reqs.map((q) => [
          fmtLocal(new Date(Number(q.timestamp)).toISOString()),
          String(q.resolvedModel ?? q.modelId ?? ''),
          String(q.message ?? '').slice(0, 40),
          String(q.promptTokens ?? '-'),
          String(q.completionTokens ?? '-'),
          q.copilotCredits == null ? '-' : Number(q.copilotCredits).toFixed(3),
          q.elapsedMs == null ? '-' : (Number(q.elapsedMs) / 1000).toFixed(1) + 's',
          String(q.toolCallRounds ?? 0),
        ])
      ),
      ''
    );
  }

  if (d.tool === 'copilot-cli') {
    const reqs = d.requests as Record<string, unknown>[];
    out.push('## Assistant messages', '', '_Copilot CLI records output tokens only (no input/cache)._', '');
    out.push(
      table(
        ['timestamp', 'model', 'phase', 'out', 'turn'],
        reqs.map((q) => [
          String(q.timestamp ?? ''),
          String(q.model ?? ''),
          String(q.phase ?? ''),
          String(q.outputTokens ?? '-'),
          String(q.turnId ?? ''),
        ])
      ),
      ''
    );
  }

  if (d.tool === 'codex') {
    const tcs = d.turnContexts as Record<string, unknown>[];
    out.push('## Turn contexts', '');
    out.push(
      table(
        ['timestamp', 'model', 'effort', 'approval', 'sandbox', 'personality'],
        tcs.map((t) => [
          String(t.timestamp),
          String(t.model ?? ''),
          String(t.effort ?? ''),
          String(t.approval_policy ?? ''),
          String((t.sandbox_policy as Record<string, unknown>)?.type ?? ''),
          String(t.personality ?? ''),
        ])
      ),
      ''
    );
    const tl = d.tokenTimeline as Record<string, unknown>[];
    out.push('## Token timeline (cumulative)', '');
    out.push(
      table(
        ['timestamp', 'total', 'input', 'cached', 'output', 'reasoning', 'ctx window', '5h used%', '7d used%'],
        tl.map((p) => {
          const info = (p.info ?? {}) as Record<string, unknown>;
          const tot = (info.total_token_usage ?? {}) as Record<string, number>;
          const rl = (p.rate_limits ?? {}) as Record<string, unknown>;
          const pri = (rl.primary ?? {}) as Record<string, number>;
          const sec = (rl.secondary ?? {}) as Record<string, number>;
          return [
            String(p.timestamp),
            fmtTokens(tot.total_tokens ?? 0),
            fmtTokens(tot.input_tokens ?? 0),
            fmtTokens(tot.cached_input_tokens ?? 0),
            fmtTokens(tot.output_tokens ?? 0),
            fmtTokens(tot.reasoning_output_tokens ?? 0),
            fmtTokens(Number(info.model_context_window ?? 0)),
            String(pri.used_percent ?? ''),
            String(sec.used_percent ?? ''),
          ];
        })
      ),
      ''
    );
  }

  return out.join('\n');
}
