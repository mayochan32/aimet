#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const USAGE = `aimet - AI Metrics for Claude Code / Codex / GitHub Copilot

Usage:
  aimet --version                 (show the installed aimet version)
  aimet --help                    (show this help)
  aimet collect [--tool claude|codex|copilot|copilot-cli] [--since <days>] [--dir <path>]
  aimet report  [--period daily|weekly|monthly] [--by tool|project|model]
              [--tool <tool>] [--model <model>] [--since <days>]
              [--start <YYYYMMDDhhmmss>] [--end <YYYYMMDDhhmmss>]
              [--json] [--md <file>]
              (--start/--end are LOCAL time; shorter forms like YYYYMMDD are
               padded to the start/end of the unit respectively)
  aimet sessions [--tool <tool>] [--id <prefix>] [--since <days>]
              [--start <YYYYMMDDhhmmss>] [--end <YYYYMMDDhhmmss>]
              [--limit <1..1000> | --all] [--json] [--md <file>]
  aimet session [--tool <tool>] [--id <prefix>] [--md <file>]
  aimet detail  [--tool <tool>] [--id <prefix>] [--file <log.jsonl>]
              [--raw] [--md <file>]
              (structured detail: metadata, event counts, request usage,
               models, and tool-specific timelines; --file requires --tool;
               --raw additionally attaches sensitive original records where
               supported; --md writes a readable Markdown file)
  aimet hook <tool>              (called by editor hooks; reads JSON on stdin)
  aimet init <tool> [--dry-run]  (install hooks & commands into the tool)

Data: ~/.aimet/metrics.db (override with AIMET_DB)
Pricing overrides: ~/.aimet/pricing.json`;

function packageVersion(): string {
  const packageFile = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error(`invalid or missing version in ${packageFile.pathname}`);
  }
  return pkg.version;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version') {
    console.log(packageVersion());
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }

  // Keep metadata-only commands independent from node:sqlite. Node 22 marks
  // the built-in SQLite module experimental and prints a warning as soon as
  // it is imported; --version and --help should remain clean on every
  // supported Node version because neither command opens the metrics DB.
  const [
    { Store },
    { collect, ingestFile },
    { report, reportRows, sessionsList, sessionsRows, sessionSummary, sessionRow, childrenRows, parseTimeArg, otelNotice },
    { reportMd, sessionsMd, sessionMd, detailMd },
    { parserFor, parserForFile },
    { initTool },
    { detail },
  ] = await Promise.all([
    import('./store.js'),
    import('./collect.js'),
    import('./report.js'),
    import('./markdown.js'),
    import('./parsers/index.js'),
    import('./init.js'),
    import('./detail.js'),
  ]);

  const { values } = parseArgs({
    args: rest,
    options: {
      tool: { type: 'string' },
      model: { type: 'string' },
      since: { type: 'string' },
      dir: { type: 'string' },
      period: { type: 'string' },
      by: { type: 'string' },
      id: { type: 'string' },
      file: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      raw: { type: 'boolean' },
      md: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (cmd) {
    case 'collect': {
      const store = new Store();
      const r = await collect({
        store,
        tools: values.tool ? [values.tool] : undefined,
        roots: values.dir ? [values.dir] : undefined,
        sinceDays: values.since ? Number(values.since) : undefined,
      });
      console.log(
        `scanned ${r.scanned} files: +${r.inserted} new, ~${r.updated} updated, ` +
          `${r.skipped} unchanged, ${r.errors} errors`
      );
      store.close();
      break;
    }

    case 'report': {
      const store = new Store();
      const opts = {
        period: values.period as never,
        by: values.by as never,
        tool: values.tool,
        model: values.model,
        sinceDays: values.since ? Number(values.since) : undefined,
        startISO: values.start ? parseTimeArg(values.start) : undefined,
        endISO: values.end ? parseTimeArg(values.end, true) : undefined,
        json: values.json,
      };
      if (values.md) {
        const notice = otelNotice(store, opts);
        writeFileSync(values.md, reportMd(reportRows(store, opts), opts) + (notice ? `\n${notice}\n` : ''));
        console.log(`wrote ${values.md}`);
      } else {
        console.log(report(store, opts));
      }
      store.close();
      break;
    }

    case 'sessions': {
      if (values.limit !== undefined && values.all) {
        throw new Error('aimet sessions: --limit and --all cannot be used together');
      }
      if (values.json && values.md) {
        throw new Error('aimet sessions: --json and --md cannot be used together');
      }
      const store = new Store();
      try {
        const opts = {
          tool: values.tool,
          id: values.id,
          sinceDays: values.since === undefined ? undefined : Number(values.since),
          startISO: values.start ? parseTimeArg(values.start) : undefined,
          endISO: values.end ? parseTimeArg(values.end, true) : undefined,
          limit: values.all ? undefined : values.limit === undefined ? 50 : Number(values.limit),
        };
        if (values.md) {
          const result = sessionsRows(store, opts);
          const filters = [
            values.tool ? `tool=${values.tool}` : '',
            values.id ? `id=${values.id}` : '',
            values.since ? `since=${values.since}` : '',
            values.start ? `start=${values.start}` : '',
            values.end ? `end=${values.end}` : '',
            values.all ? 'all' : `limit=${opts.limit}`,
          ].filter(Boolean);
          const notice = otelNotice(store, opts);
          writeFileSync(values.md, sessionsMd(result.rows, result.total, filters) + (notice ? `\n${notice}\n` : ''));
          console.log(`wrote ${values.md}`);
        } else if (values.json) {
          console.log(JSON.stringify(sessionsRows(store, opts).rows, null, 2));
        } else {
          const notice = otelNotice(store, opts);
          console.log(sessionsList(store, opts) + (notice ? `\n\n${notice}` : ''));
        }
      } finally {
        store.close();
      }
      break;
    }

    case 'session': {
      const store = new Store();
      if (values.md) {
        const r = sessionRow(store, { tool: values.tool, id: values.id });
        if (!r) {
          console.error('Session not found.');
          process.exit(1);
        }
        const notice = otelNotice(store, { tool: String(r.tool), id: String(r.session_id) });
        writeFileSync(values.md, sessionMd(r, childrenRows(store, r.session_id)) + (notice ? `\n${notice}\n` : ''));
        console.log(`wrote ${values.md}`);
      } else {
        const r = sessionRow(store, { tool: values.tool, id: values.id });
        const notice = r ? otelNotice(store, { tool: String(r.tool), id: String(r.session_id) }) : '';
        console.log(sessionSummary(store, { tool: values.tool, id: values.id }) + (notice ? `\n${notice}` : ''));
      }
      store.close();
      break;
    }

    case 'detail': {
      let tool = values.tool ?? '';
      let file = values.file ?? '';
      if (file && !tool) {
        throw new Error('aimet detail: --file requires --tool');
      }
      if (tool && !parserFor(tool)) {
        throw new Error(`aimet detail: unknown tool "${tool}"`);
      }
      if (!file) {
        // Resolve the latest matching session from the DB.
        const store = new Store();
        const where: string[] = [];
        const params: unknown[] = [];
        if (values.tool) { where.push('tool = ?'); params.push(values.tool); }
        if (values.id) { where.push('session_id LIKE ?'); params.push(values.id + '%'); }
        const rows = store.query(
          `SELECT tool, log_path FROM sessions
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY last_event_at DESC LIMIT 1`,
          ...params
        );
        store.close();
        if (rows.length === 0) {
          console.error('aimet detail: session not found (run `aimet collect` first)');
          process.exit(1);
        }
        tool = String(rows[0].tool);
        file = String(rows[0].log_path);
      }
      if (!existsSync(file)) {
        console.error(`aimet detail: log file no longer exists: ${file}`);
        process.exit(1);
      }
      if (values.raw) {
        console.error(
          'aimet detail --raw: output may include system prompts, tool definitions, ' +
            'file paths and conversation fragments. Do NOT paste it into issues, chat, ' +
            'or external AI services.'
        );
      }
      const d = await detail(tool, file, Boolean(values.raw));
      if (values.md) {
        writeFileSync(values.md, detailMd(d));
        console.log(`wrote ${values.md}`);
      } else {
        console.log(JSON.stringify(d, null, 2));
      }
      break;
    }

    case 'hook': {
      const tool = positional[0] ?? values.tool ?? '';
      const parser = parserFor(tool);
      if (!parser) {
        console.error(`aimet hook: unknown tool "${tool}"`);
        process.exit(0); // never fail the host editor
      }
      const store = new Store();
      try {
        let handled = false;
        const raw = await readStdin();
        if (raw.trim()) {
          try {
            const evt = JSON.parse(raw) as Record<string, unknown>;
            const p = [
              evt.agent_transcript_path,
              evt.transcript_path,
              evt.rollout_path,
              evt.session_file,
              evt.log_path,
            ]
              .find((v): v is string => typeof v === 'string' && existsSync(v));
            // Handled only if the file actually parsed into a session
            // (VS Code may pass a transcript in a different format).
            if (p) {
              const exactParser = parserForFile(tool, p) ?? parser;
              handled = (await ingestFile(store, exactParser, p)) != null;
            }
          } catch {
            /* non-JSON stdin: fall through */
          }
        }
        // Fallback: incremental scan of recent logs for this tool.
        // ~/.copilot/hooks is read by BOTH VS Code and Copilot CLI, so a
        // "copilot" hook invocation also sweeps copilot-cli sessions.
        const sweep = parser.tool === 'copilot' ? ['copilot', 'copilot-cli'] : [parser.tool];
        if (!handled) await collect({ store, tools: sweep, sinceDays: 2, quiet: true });
      } finally {
        store.close();
      }
      // Codex SubagentStop requires JSON on successful stdout. An empty object
      // is also a valid advisory response for SessionEnd; other hosts ignore it.
      if (tool === 'codex') process.stdout.write('{}\n');
      break;
    }

    case 'init': {
      console.log(initTool(positional[0] ?? '', Boolean(values['dry-run'])));
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`aimet: ${err}`);
  // Lifecycle hooks are advisory. A local DB/log failure must never make the
  // host editor or agent fail its own SessionEnd/Stop event.
  if (process.argv[2] === 'hook') {
    if (process.argv[3] === 'codex') process.stdout.write('{}\n');
    process.exit(0);
  }
  process.exit(1);
});
