import { delimiter, posix, win32 } from 'node:path';
import { homedir, platform } from 'node:os';

type Env = NodeJS.ProcessEnv;

function configuredHome(
  variable: string | undefined,
  fallbackName: string,
  os: NodeJS.Platform,
  home: string,
  cwd: string
): string {
  const p = os === 'win32' ? win32 : posix;
  const configured = variable?.trim();
  if (!configured) return p.join(home, fallbackName);
  return p.isAbsolute(configured) ? p.normalize(configured) : p.resolve(cwd, configured);
}

/** Claude Code state root. CLAUDE_CONFIG_DIR overrides ~/.claude. */
export function claudeConfigDir(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  cwd: string = process.cwd()
): string {
  return configuredHome(env.CLAUDE_CONFIG_DIR, '.claude', os, home, cwd);
}

/** Codex state root. CODEX_HOME overrides ~/.codex. */
export function codexHome(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  cwd: string = process.cwd()
): string {
  return configuredHome(env.CODEX_HOME, '.codex', os, home, cwd);
}

/** GitHub Copilot CLI state root. COPILOT_HOME overrides ~/.copilot. */
export function copilotHome(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  cwd: string = process.cwd()
): string {
  return configuredHome(env.COPILOT_HOME, '.copilot', os, home, cwd);
}

/** VS Code user-data directories for the current platform. */
export function vscodeUserDirs(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  cwd: string = env.VSCODE_CWD || process.cwd()
): string[] {
  const p = os === 'win32' ? win32 : posix;
  const products = ['Code', 'Code - Insiders', 'VSCodium'];
  let base: string;

  const resolvePath = (value: string): string =>
    p.isAbsolute(value) ? p.normalize(value) : p.resolve(cwd, value);

  // Match VS Code's user-data-path precedence. Portable mode is tied to one
  // installation and therefore has no product-name segment.
  const portable = env.VSCODE_PORTABLE?.trim();
  if (portable) {
    return [p.join(resolvePath(portable), 'user-data', 'User')];
  }

  const vscodeAppData = env.VSCODE_APPDATA?.trim();
  if (vscodeAppData) {
    base = resolvePath(vscodeAppData);
    return products.map((product) => p.join(base, product, 'User'));
  }

  if (os === 'win32') {
    // APPDATA is authoritative when Windows profiles are redirected/roaming.
    base = env.APPDATA || p.join(home, 'AppData', 'Roaming');
  } else if (os === 'darwin') {
    base = p.join(home, 'Library', 'Application Support');
  } else {
    base = env.XDG_CONFIG_HOME || p.join(home, '.config');
  }

  return products.map((product) => p.join(base, product, 'User'));
}

/**
 * Copilot log roots, including optional explicit overrides.
 *
 * Chat snapshots remain under workspaceStorage. Recent Copilot builds write
 * agent debug JSONL to globalStorage instead, while older builds wrote it
 * below each workspaceStorage hash. Scan both locations during the rollout.
 */
export function copilotWorkspaceRoots(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  cwd: string = env.VSCODE_CWD || process.cwd()
): string[] {
  const p = os === 'win32' ? win32 : posix;
  const pathDelimiter = os === 'win32' ? ';' : delimiter;
  const explicit = (env.AIMET_COPILOT_DIR ?? '')
    .split(pathDelimiter)
    .map((v) => v.trim())
    .filter(Boolean);
  const detected = vscodeUserDirs(env, os, home, cwd).flatMap((dir) => [
    p.join(dir, 'workspaceStorage'),
    p.join(dir, 'globalStorage', 'github.copilot-chat'),
  ]);
  return [...new Set([...explicit, ...detected])];
}
