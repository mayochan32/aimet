import { delimiter, posix, win32 } from 'node:path';
import { homedir, platform } from 'node:os';

type Env = NodeJS.ProcessEnv;

/** VS Code user-data directories for the current platform. */
export function vscodeUserDirs(
  env: Env = process.env,
  os: NodeJS.Platform = platform(),
  home: string = homedir()
): string[] {
  const p = os === 'win32' ? win32 : posix;
  const products = ['Code', 'Code - Insiders', 'VSCodium'];
  let base: string;

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
  home: string = homedir()
): string[] {
  const p = os === 'win32' ? win32 : posix;
  const pathDelimiter = os === 'win32' ? ';' : delimiter;
  const explicit = (env.AIMET_COPILOT_DIR ?? '')
    .split(pathDelimiter)
    .map((v) => v.trim())
    .filter(Boolean);
  const detected = vscodeUserDirs(env, os, home).flatMap((dir) => [
    p.join(dir, 'workspaceStorage'),
    p.join(dir, 'globalStorage', 'github.copilot-chat'),
  ]);
  return [...new Set([...explicit, ...detected])];
}
