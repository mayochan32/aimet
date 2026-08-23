import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { claudeConfigDir, codexHome, copilotHome, vscodeUserDirs } from './paths.js';

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

/** Remove only aimet's obsolete direct-command form, preserving all user hooks. */
function removeDirectHookCommand(list: unknown[], command: string): boolean {
  const kept = list.filter(
    (entry) => !(isRecord(entry) && entry.type === 'command' && entry.command === command)
  );
  if (kept.length === list.length) return false;
  list.splice(0, list.length, ...kept);
  return true;
}

function hookMap(config: Record<string, unknown>, path: string): Record<string, unknown> {
  const value = config.hooks;
  if (value === undefined) {
    const hooks: Record<string, unknown> = {};
    config.hooks = hooks;
    return hooks;
  }
  if (!isRecord(value)) {
    throw new Error(`refusing to modify ${path}: hooks must be a JSON object`);
  }
  return value;
}

function hookList(hooks: Record<string, unknown>, event: string, path: string): unknown[] {
  const value = hooks[event];
  if (value === undefined) {
    const list: unknown[] = [];
    hooks[event] = list;
    return list;
  }
  if (!Array.isArray(value)) {
    throw new Error(`refusing to modify ${path}: hooks.${event} must be a JSON array`);
  }
  return value;
}

function ensureNestedHook(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  path: string,
  timeout?: number
): boolean {
  const list = hookList(hooks, event, path);
  if (hasNestedHookCommand(list, command)) return false;
  list.push({
    hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) }],
  });
  return true;
}

function ensureDirectHook(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  path: string
): boolean {
  const list = hookList(hooks, event, path);
  if (hasDirectHookCommand(list, command)) return false;
  list.push({ type: 'command', command });
  return true;
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

/** Register parent/child completion hooks + /metrics command for Claude Code. */
export function initClaude(dryRun: boolean, configDir: string = claudeConfigDir()): string {
  const log: string[] = [];
  const settingsPath = join(configDir, 'settings.json');
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
  const hooks = hookMap(settings, settingsPath);
  const changed = [
    ensureNestedHook(hooks, 'SessionEnd', HOOK_CMD('claude'), settingsPath),
    ensureNestedHook(hooks, 'SubagentStop', HOOK_CMD('claude'), settingsPath),
  ].some(Boolean);
  if (changed) {
    writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', dryRun, log);
  } else {
    log.push(`hooks already registered in ${settingsPath}`);
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

/** Register current Codex hooks.json schema + the packaged aimet metrics Skill. */
export function initCodex(
  dryRun: boolean,
  configDir: string = codexHome(),
  userSkillsDir: string = join(homedir(), '.agents', 'skills')
): string {
  const log: string[] = [];
  const hooksPath = join(configDir, 'hooks.json');
  const cfg = existsSync(hooksPath) ? readJson(hooksPath) : {};
  const hooks = hookMap(cfg, hooksPath);
  const sessionEnd = hookList(hooks, 'SessionEnd', hooksPath);
  const changed = [
    removeDirectHookCommand(sessionEnd, HOOK_CMD('codex')),
    ensureNestedHook(hooks, 'SessionEnd', HOOK_CMD('codex'), hooksPath, 3),
    ensureNestedHook(hooks, 'SubagentStop', HOOK_CMD('codex'), hooksPath),
  ].some(Boolean);
  if (changed) {
    writeFile(hooksPath, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
  } else {
    log.push(`hooks already registered in ${hooksPath}`);
  }

  writeFile(
    join(userSkillsDir, 'aimet-metrics', 'SKILL.md'),
    readFileSync(
      new URL('../integrations/codex/skills/aimet-metrics/SKILL.md', import.meta.url),
      'utf8'
    ),
    dryRun,
    log
  );
  writeFile(
    join(userSkillsDir, 'aimet-metrics', 'agents', 'openai.yaml'),
    readFileSync(
      new URL('../integrations/codex/skills/aimet-metrics/agents/openai.yaml', import.meta.url),
      'utf8'
    ),
    dryRun,
    log
  );
  if (existsSync(join(configDir, 'prompts', 'metrics.md'))) {
    log.push(
      'note: legacy prompts/metrics.md was left untouched; current Codex uses $aimet-metrics'
    );
  }
  return log.join('\n');
}

function installCopilotHooks(path: string, dryRun: boolean, log: string[]): void {
  const cfg = existsSync(path) ? readJson(path) : {};
  const hooks = hookMap(cfg, path);
  const changed = [
    cfg.version !== 1,
    ensureDirectHook(hooks, 'Stop', HOOK_CMD('copilot'), path),
    ensureDirectHook(hooks, 'SubagentStop', HOOK_CMD('copilot'), path),
  ].some(Boolean);
  cfg.version = 1;
  if (changed) writeFile(path, JSON.stringify(cfg, null, 2) + '\n', dryRun, log);
  else log.push(`hooks already registered in ${path}`);
}

/**
 * Register a VS Code agent hook (Preview) + /metrics prompt file for
 * GitHub Copilot Chat. Hook location: ~/.copilot/hooks/*.json (user level),
 * same event schema as Claude Code. Stop fires when the parent agent finishes
 * a turn; SubagentStop fires for supported child-agent kinds.
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
  const standardHome = join(home, '.copilot');
  const configuredHome = copilotHome(env, os, home, cwd);
  for (const root of [...new Set([standardHome, configuredHome])]) {
    installCopilotHooks(join(root, 'hooks', 'aimet.json'), dryRun, log);
  }
  log.push('note: VS Code agent hooks are in Preview; Copilot CLI also reads these user hooks');

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
