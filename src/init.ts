import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOOK_CMD = (tool: string) => `aimet hook ${tool}`;

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(path: string, content: string, dryRun: boolean, log: string[]): void {
  log.push(`${dryRun ? '[dry-run] would write' : 'wrote'} ${path}`);
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Register the SessionEnd hook + /metrics command for Claude Code. */
export function initClaude(dryRun: boolean): string {
  const log: string[] = [];
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const entry = { hooks: [{ type: 'command', command: HOOK_CMD('claude') }] };
  const list = (hooks.SessionEnd ??= []) as unknown[];
  if (!JSON.stringify(list).includes(HOOK_CMD('claude'))) {
    list.push(entry);
    writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', dryRun, log);
  } else {
    log.push(`hook already registered in ${settingsPath}`);
  }

  writeFile(
    join(homedir(), '.claude', 'commands', 'metrics.md'),
    [
      '---',
      'description: Show AI usage metrics for the current session',
      'allowed-tools: Bash(aimet:*)',
      '---',
      '',
      'Run `aimet hook claude` first (pass the current session transcript if known),',
      'then run `aimet session --tool claude` and show the result to the user as-is.',
      'For period summaries the user can ask for, use `aimet report --by project --since 7`.',
      '',
    ].join('\n'),
    dryRun,
    log
  );
  return log.join('\n');
}

/** Register hooks.json + /metrics custom prompt for Codex CLI. */
export function initCodex(dryRun: boolean): string {
  const log: string[] = [];
  const hooksPath = join(homedir(), '.codex', 'hooks.json');
  const cfg = existsSync(hooksPath) ? readJson(hooksPath) : {};
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
  const list = (hooks.SessionEnd ??= []) as unknown[];
  if (!JSON.stringify(list).includes('aimet hook codex')) {
    list.push({ type: 'command', command: HOOK_CMD('codex') });
    writeFile(hooksPath, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
    log.push('note: verify the hook fires with `codex` -> /hooks (schema may vary by version)');
  } else {
    log.push(`hook already registered in ${hooksPath}`);
  }

  writeFile(
    join(homedir(), '.codex', 'prompts', 'metrics.md'),
    [
      'Show my AI usage metrics.',
      '',
      'Run the shell command `aimet hook codex` and then `aimet session --tool codex`,',
      'and present the output to me unchanged. If I ask for a weekly view,',
      'run `aimet report --period weekly --by project`.',
      '',
    ].join('\n'),
    dryRun,
    log
  );
  return log.join('\n');
}

export function initTool(tool: string, dryRun: boolean): string {
  switch (tool) {
    case 'claude':
      return initClaude(dryRun);
    case 'codex':
      return initCodex(dryRun);
    case 'copilot':
      return 'copilot: not implemented yet (log schema unconfirmed). Planned: hooks in ~/.copilot + custom agent.';
    default:
      return `unknown tool: ${tool} (expected claude | codex | copilot)`;
  }
}
