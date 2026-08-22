import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Store } from '../dist/store.js';
import { claudeParser } from '../dist/parsers/claude.js';
import { codexParser } from '../dist/parsers/codex.js';
import { copilotParser } from '../dist/parsers/copilot.js';
import { copilotCliParser } from '../dist/parsers/copilotcli.js';
import { copilotSubagentParser } from '../dist/parsers/copilotsubagent.js';
import {
  detailClaude,
  detailCodex,
  detailCopilot,
  detailCopilotCli,
  detailCopilotSpan,
} from '../dist/detail.js';
import { reportRows, sessionRow, childrenRows } from '../dist/report.js';
import { detailMd, reportMd, sessionMd } from '../dist/markdown.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (...parts) => join(root, 'test', 'fixtures', ...parts);
const generatedAt = '2026-08-23T00:00:00.000Z';

function canonicalCost(metric) {
  const t = metric.tokens;
  if (metric.tool === 'claude') {
    return ((t.input ?? 0) * 3 + (t.output ?? 0) * 15 +
      (t.cacheRead ?? 0) * 0.3 + (t.cacheWrite ?? 0) * 3.75) / 1e6;
  }
  if (metric.tool === 'codex') {
    const gpt52 = metric.model.startsWith('gpt-5.2');
    const rates = gpt52 ? [1.75, 14, 0.175] : [1.25, 10, 0.125];
    return ((t.input ?? 0) * rates[0] + (t.output ?? 0) * rates[1] +
      (t.cacheRead ?? 0) * rates[2]) / 1e6;
  }
  return metric.costUsd;
}

async function parsed(parser, path, label) {
  const metric = await parser.parseFile(path);
  if (!metric) throw new Error(`fixture did not parse: ${path}`);
  metric.logPath = `<fixtures>/${label}`;
  metric.costUsd = canonicalCost(metric);
  return metric;
}

function sanitizedDetail(detail, label) {
  return { ...detail, logPath: `<fixtures>/${label}` };
}

export async function buildExamples() {
  const temp = mkdtempSync(join(tmpdir(), 'aimet-examples-'));
  const store = new Store(join(temp, 'metrics.db'));
  try {
    const claudeBase = fixture('claude-multi-agent', '-proj-claude');
    const claudeParentPath = join(claudeBase, 'parent-session.jsonl');
    const claudeAlphaPath = join(
      claudeBase, 'parent-session', 'subagents', 'agent-alpha.jsonl'
    );
    const claudeBetaPath = join(
      claudeBase, 'parent-session', 'subagents', 'agent-beta.jsonl'
    );
    const codexParentPath = fixture('codex-basic.jsonl');
    const codexChildPath = fixture('codex-subagent-basic.jsonl');
    const copilotParentPath = fixture('real', 'copilot-golden-parent.jsonl');
    const copilotChildPaths = [1, 2, 3, 4].map((n) =>
      fixture('real', `copilot-golden-child-${n}.jsonl`)
    );
    const copilotCliPath = fixture('copilotcli-basic.jsonl');

    const metrics = [
      await parsed(claudeParser, claudeParentPath, 'claude/parent-session.jsonl'),
      await parsed(claudeParser, claudeAlphaPath, 'claude/subagents/agent-alpha.jsonl'),
      await parsed(claudeParser, claudeBetaPath, 'claude/subagents/agent-beta.jsonl'),
    ];

    const codexParent = await parsed(codexParser, codexParentPath, 'codex/parent.jsonl');
    // The child fixture carries this documented parent id. Re-key the parent
    // sample so the Markdown demonstrates the real parent/child view.
    codexParent.sessionId = 'bbbb2222-0000-0000-0000-000000000002';
    metrics.push(
      codexParent,
      await parsed(codexParser, codexChildPath, 'codex/subagent.jsonl')
    );

    const copilotParent = await parsed(
      copilotParser,
      copilotParentPath,
      'copilot/main.jsonl'
    );
    metrics.push(copilotParent);
    for (let i = 0; i < copilotChildPaths.length; i++) {
      metrics.push(await parsed(
        copilotSubagentParser,
        copilotChildPaths[i],
        `copilot/runSubagent-${i + 1}.jsonl`
      ));
    }
    metrics.push(await parsed(copilotCliParser, copilotCliPath, 'copilot-cli/events.jsonl'));

    for (const metric of metrics) store.upsert(metric);

    const session = (tool, id) => {
      const row = sessionRow(store, { tool, id });
      if (!row) throw new Error(`missing generated session: ${tool}/${id}`);
      return sessionMd(row, childrenRows(store, row.session_id), true);
    };

    const claudeDetail = sanitizedDetail(
      await detailClaude(fixture('claude-basic.jsonl')),
      'claude/basic.jsonl'
    );
    const codexDetail = sanitizedDetail(
      await detailCodex(codexParentPath),
      'codex/parent.jsonl'
    );
    const copilotDetail = sanitizedDetail(
      await detailCopilot(copilotParentPath),
      'copilot/chat-session.jsonl'
    );
    const copilotChildDetail = sanitizedDetail(
      await detailCopilotSpan(copilotChildPaths[0]),
      'copilot/runSubagent-1.jsonl'
    );
    const copilotCliDetail = sanitizedDetail(
      await detailCopilotCli(copilotCliPath),
      'copilot-cli/events.jsonl'
    );

    const report = reportRows(store, { period: 'monthly', by: 'tool' });
    return {
      'report.md': reportMd(report, {
        period: 'monthly',
        by: 'tool',
        generatedAt,
        utc: true,
      }),
      'session-claude.md': session('claude', 'parent-session'),
      'session-codex.md': session('codex', codexParent.sessionId),
      'session-copilot.md': session('copilot', copilotParent.sessionId),
      'detail-claude.md': detailMd(claudeDetail, true),
      'detail-codex.md': detailMd(codexDetail, true),
      'detail-copilot.md': detailMd(copilotDetail, true),
      'detail-copilot-subagent.md': detailMd(copilotChildDetail, true),
      'detail-copilotcli.md': detailMd(copilotCliDetail, true),
    };
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function writeExamples(outputDir = join(root, 'examples')) {
  mkdirSync(outputDir, { recursive: true });
  const examples = await buildExamples();
  for (const [name, content] of Object.entries(examples)) {
    writeFileSync(join(outputDir, name), content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeExamples();
}
