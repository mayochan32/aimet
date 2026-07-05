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

/**
 * Register a VS Code agent hook (Preview) + /metrics prompt file for
 * GitHub Copilot Chat. Hook location: ~/.copilot/hooks/*.json (user level),
 * same event schema as Claude Code. Fires on Stop (session ends).
 */
export function initCopilot(dryRun: boolean): string {
  const log: string[] = [];
  const hooksPath = join(homedir(), '.copilot', 'hooks', 'aimet.json');
  const cfg = existsSync(hooksPath) ? readJson(hooksPath) : {};
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
  const list = (hooks.Stop ??= []) as unknown[];
  if (!JSON.stringify(list).includes(HOOK_CMD('copilot'))) {
    list.push({ type: 'command', command: HOOK_CMD('copilot') });
    writeFile(hooksPath, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
    log.push('note: VS Code agent hooks are in Preview. Verify with /hooks in Copilot Chat');
  } else {
    log.push(`hook already registered in ${hooksPath}`);
  }

  // /metrics prompt file into every VS Code user-data dir that exists.
  const userDirs = [
    join(homedir(), 'Library', 'Application Support', 'Code', 'User'), // macOS
    join(homedir(), '.config', 'Code', 'User'), // Linux
    join(homedir(), 'AppData', 'Roaming', 'Code', 'User'), // Windows
  ].filter((d) => existsSync(d));
  const prompt = [
    '---',
    'description: Show AI usage metrics for my Copilot sessions',
    '---',
    '',
    'Run the terminal command `aimet collect --tool copilot --since 2` and then',
    '`aimet session --tool copilot`, and show me the output unchanged.',
    'If I ask for a weekly view, run `aimet report --period weekly --by tool`.',
    '',
  ].join('\n');
  for (const dir of userDirs) {
    writeFile(join(dir, 'prompts', 'metrics.prompt.md'), prompt, dryRun, log);
  }
  if (userDirs.length === 0) {
    log.push('note: no VS Code user dir found; /metrics prompt file was not installed');
  }
  return log.join('\n');
}

export function initTool(tool: string, dryRun: boolean): string {
  switch (tool) {
    case 'claude':
      return initClaude(dryRun);
    case 'codex':
      return initCodex(dryRun);
    case 'copilot':
      return initCopilot(dryRun);
    default:
      return `unknown tool: ${tool} (expected claude | codex | copilot)`;
  }
}
