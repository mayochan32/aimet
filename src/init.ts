import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { claudeConfigDir, codexHome, vscodeUserDirs } from './paths.js';

const HOOK_CMD = (tool: string) => `aimet hook ${tool}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Match a hook by its command field and expected schema, never by JSON text. */
function hasDirectHookCommand(list: unknown[], command: string): boolean {
  return list.some(
    (entry) => isRecord(entry) && entry.type === 'command' && entry.command === command
  );
}

function hasNestedHookCommand(list: unknown[], command: string): boolean {
  return list.some(
    (entry) => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(
      (hook) => isRecord(hook) && hook.type === 'command' && hook.command === command
    )
  );
}

/**
 * Parse an existing config file. Throws (rather than returning {}) when the
 * file exists but is not valid JSON, so we never silently overwrite and lose
 * a user's real settings. Callers only invoke this when the file exists.
 */
function readJson(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `refusing to modify ${path}: it is not valid JSON (${(e as Error).message}). ` +
        `Fix or move the file, then re-run. Your settings were left untouched.`
    );
  }
}

/** Back up the existing file and write atomically (temp file + rename). */
function writeFile(path: string, content: string, dryRun: boolean, log: string[]): void {
  log.push(`${dryRun ? '[dry-run] would write' : 'wrote'} ${path}`);
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const bak = `${path}.bak`;
    copyFileSync(path, bak);
    log.push(`backed up previous file to ${bak}`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on the same filesystem
}

/** Register the SessionEnd hook + /metrics command for Claude Code. */
export function initClaude(dryRun: boolean, configDir: string = claudeConfigDir()): string {
  const log: string[] = [];
  const settingsPath = join(configDir, 'settings.json');
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const entry = { hooks: [{ type: 'command', command: HOOK_CMD('claude') }] };
  const list = (hooks.SessionEnd ??= []) as unknown[];
  if (!hasNestedHookCommand(list, HOOK_CMD('claude'))) {
    list.push(entry);
    writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', dryRun, log);
  } else {
    log.push(`hook already registered in ${settingsPath}`);
  }

  writeFile(
    join(configDir, 'commands', 'metrics.md'),
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
export function initCodex(dryRun: boolean, configDir: string = codexHome()): string {
  const log: string[] = [];
  const hooksPath = join(configDir, 'hooks.json');
  const cfg = existsSync(hooksPath) ? readJson(hooksPath) : {};
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
  const list = (hooks.SessionEnd ??= []) as unknown[];
  if (!hasDirectHookCommand(list, HOOK_CMD('codex'))) {
    list.push({ type: 'command', command: HOOK_CMD('codex') });
    writeFile(hooksPath, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
    log.push('note: verify the hook fires with `codex` -> /hooks (schema may vary by version)');
  } else {
    log.push(`hook already registered in ${hooksPath}`);
  }

  writeFile(
    join(configDir, 'prompts', 'metrics.md'),
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
export function initCopilot(
  dryRun: boolean,
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    os?: NodeJS.Platform;
    cwd?: string;
  } = {}
): string {
  const log: string[] = [];
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const os = options.os ?? platform();
  const cwd = options.cwd ?? env.VSCODE_CWD ?? process.cwd();
  const hooksPath = join(home, '.copilot', 'hooks', 'aimet.json');
  const cfg = existsSync(hooksPath) ? readJson(hooksPath) : {};
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
  const list = (hooks.Stop ??= []) as unknown[];
  if (!hasDirectHookCommand(list, HOOK_CMD('copilot'))) {
    list.push({ type: 'command', command: HOOK_CMD('copilot') });
    writeFile(hooksPath, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
    log.push('note: VS Code agent hooks are in Preview. Verify with /hooks in Copilot Chat');
  } else {
    log.push(`hook already registered in ${hooksPath}`);
  }

  // /metrics prompt file into every VS Code user-data dir that exists. For a
  // dry run, retain explicitly configured roots even before they are created
  // so the caller can verify the resolved destination without changing disk.
  const hasConfiguredUserDataRoot = Boolean(
    env.VSCODE_PORTABLE?.trim() || env.VSCODE_APPDATA?.trim()
  );
  const userDirs = vscodeUserDirs(env, os, home, cwd).filter(
    (d) => existsSync(d) || (dryRun && hasConfiguredUserDataRoot)
  );
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
