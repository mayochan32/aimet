#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { collect, ingestFile } from './collect.js';
import { writeFileSync } from 'node:fs';
import { report, reportRows, sessionSummary, sessionRow } from './report.js';
import { reportMd, sessionMd, detailMd } from './markdown.js';
import { parserFor } from './parsers/index.js';
import { initTool } from './init.js';
import { detail } from './detail.js';

const USAGE = `aimet - AI Metrics for Claude Code / Codex / GitHub Copilot

Usage:
  aimet collect [--tool claude|codex] [--since <days>] [--dir <path>]
  aimet report  [--period daily|weekly|monthly] [--by tool|project|model]
              [--tool <tool>] [--since <days>] [--json] [--md <file>]
  aimet session [--tool <tool>] [--id <prefix>] [--md <file>]
  aimet detail  [--tool <tool>] [--id <prefix>] [--file <log.jsonl>]
              [--raw] [--md <file>]
              (full JSON dump of everything the session log records;
               --raw also includes base_instructions / dynamic_tools /
               original records; --md writes a readable Markdown file)
  aimet hook <tool>              (called by editor hooks; reads JSON on stdin)
  aimet init <tool> [--dry-run]  (install hooks & commands into the tool)

Data: ~/.aimet/metrics.db (override with AIMET_DB)
Pricing overrides: ~/.aimet/pricing.json`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tool: { type: 'string' },
      since: { type: 'string' },
      dir: { type: 'string' },
      period: { type: 'string' },
      by: { type: 'string' },
      id: { type: 'string' },
      file: { type: 'string' },
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
        sinceDays: values.since ? Number(values.since) : undefined,
        json: values.json,
      };
      if (values.md) {
        writeFileSync(values.md, reportMd(reportRows(store, opts), opts));
        console.log(`wrote ${values.md}`);
      } else {
        console.log(report(store, opts));
      }
      store.close();
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
        writeFileSync(values.md, sessionMd(r));
        console.log(`wrote ${values.md}`);
      } else {
        console.log(sessionSummary(store, { tool: values.tool, id: values.id }));
      }
      store.close();
      break;
    }

    case 'detail': {
      let tool = values.tool ?? '';
      let file = values.file ?? '';
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
           ORDER BY ended_at DESC LIMIT 1`,
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
            const p = [evt.transcript_path, evt.rollout_path, evt.session_file, evt.log_path]
              .find((v): v is string => typeof v === 'string' && existsSync(v));
            // Handled only if the file actually parsed into a session
            // (VS Code may pass a transcript in a different format).
            if (p) handled = (await ingestFile(store, parser, p)) != null;
          } catch {
            /* non-JSON stdin: fall through */
          }
        }
        // Fallback: incremental scan of recent logs for this tool.
        if (!handled) await collect({ store, tools: [parser.tool], sinceDays: 2, quiet: true });
      } finally {
        store.close();
      }
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
  process.exit(1);
});
