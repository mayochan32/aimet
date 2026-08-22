import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

import { initClaude, initCodex, initCopilot } from '../dist/init.js';

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function directCommandCount(list, command) {
  return list.filter((entry) => entry?.type === 'command' && entry?.command === command).length;
}

function nestedCommandCount(list, command) {
  return list.reduce(
    (count, entry) => count + (entry?.hooks ?? []).filter(
      (hook) => hook?.type === 'command' && hook?.command === command
    ).length,
    0
  );
}

test('init dry-run reports missing configured roots without creating them', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-dry-run-'));
  const claudeRoot = join(base, 'not created Claude 日本語');
  const codexRoot = join(base, 'not created Codex 日本語');
  const portableRoot = join(base, 'not created VS Code Portable 日本語');
  const appDataRoot = join(base, 'not created VS Code AppData 日本語');
  const home = join(base, 'not created home');

  const claudeOutput = initClaude(true, claudeRoot);
  const codexOutput = initCodex(true, codexRoot);
  const portableOutput = initCopilot(true, {
    home,
    env: { VSCODE_PORTABLE: portableRoot },
    os: platform(),
    cwd: base,
  });
  const appDataOutput = initCopilot(true, {
    home,
    env: { VSCODE_APPDATA: appDataRoot },
    os: platform(),
    cwd: base,
  });

  assert.ok(claudeOutput.includes(join(claudeRoot, 'settings.json')));
  assert.ok(claudeOutput.includes(join(claudeRoot, 'commands', 'metrics.md')));
  assert.ok(codexOutput.includes(join(codexRoot, 'hooks.json')));
  assert.ok(codexOutput.includes(join(codexRoot, 'skills', 'aimet-metrics', 'SKILL.md')));
  assert.ok(portableOutput.includes(
    join(portableRoot, 'user-data', 'User', 'prompts', 'metrics.prompt.md')
  ));
  for (const product of ['Code', 'Code - Insiders', 'VSCodium']) {
    assert.ok(appDataOutput.includes(
      join(appDataRoot, product, 'User', 'prompts', 'metrics.prompt.md')
    ));
  }

  for (const path of [claudeRoot, codexRoot, portableRoot, appDataRoot, home]) {
    assert.equal(existsSync(path), false, `dry-run must not create ${path}`);
  }
});

test('normal init creates files, preserves settings, backs up, and stays idempotent', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-write-'));
  const claudeRoot = join(base, 'Claude state');
  const codexRoot = join(base, 'Codex state');
  const home = join(base, 'home');
  const portableRoot = join(base, 'VS Code Portable');
  const vscodeUser = join(portableRoot, 'user-data', 'User');
  const claudeSettings = join(claudeRoot, 'settings.json');
  const codexHooks = join(codexRoot, 'hooks.json');
  const copilotHooks = join(home, '.copilot', 'hooks', 'aimet.json');

  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
  mkdirSync(vscodeUser, { recursive: true });
  const originalClaude = JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ command: 'keep' }] } });
  const originalCodex = JSON.stringify({ approval: 'ask', hooks: { Before: [{ command: 'keep' }] } });
  const originalCopilot = JSON.stringify({ version: 1, hooks: { Start: [{ command: 'keep' }] } });
  writeFileSync(claudeSettings, originalClaude);
  writeFileSync(codexHooks, originalCodex);
  writeFileSync(copilotHooks, originalCopilot);

  initClaude(false, claudeRoot);
  initCodex(false, codexRoot);
  initCopilot(false, {
    home,
    env: { VSCODE_PORTABLE: portableRoot },
    os: platform(),
    cwd: base,
  });

  assert.equal(readFileSync(`${claudeSettings}.bak`, 'utf8'), originalClaude);
  assert.equal(readFileSync(`${codexHooks}.bak`, 'utf8'), originalCodex);
  assert.equal(readFileSync(`${copilotHooks}.bak`, 'utf8'), originalCopilot);
  assert.ok(existsSync(join(claudeRoot, 'commands', 'metrics.md')));
  assert.ok(existsSync(join(codexRoot, 'skills', 'aimet-metrics', 'SKILL.md')));
  assert.ok(existsSync(join(vscodeUser, 'prompts', 'metrics.prompt.md')));

  initClaude(false, claudeRoot);
  initCodex(false, codexRoot);
  initCopilot(false, {
    home,
    env: { VSCODE_PORTABLE: portableRoot },
    os: platform(),
    cwd: base,
  });

  const claude = json(claudeSettings);
  const codex = json(codexHooks);
  const copilot = json(copilotHooks);
  assert.equal(claude.theme, 'dark');
  assert.equal(codex.approval, 'ask');
  assert.equal(copilot.version, 1);
  assert.equal(nestedCommandCount(claude.hooks.SessionEnd, 'aimet hook claude'), 1);
  assert.equal(nestedCommandCount(claude.hooks.SubagentStop, 'aimet hook claude'), 1);
  assert.equal(nestedCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 1);
  assert.equal(nestedCommandCount(codex.hooks.SubagentStop, 'aimet hook codex'), 1);
  assert.equal(directCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 0);
  assert.equal(directCommandCount(copilot.hooks.Stop, 'aimet hook copilot'), 1);
  assert.equal(directCommandCount(copilot.hooks.SubagentStop, 'aimet hook copilot'), 1);
});

test('similar text or a wrong-shaped command does not masquerade as an installed hook', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-exact-hook-'));
  const claudeRoot = join(base, 'claude');
  const codexRoot = join(base, 'codex');
  const home = join(base, 'home');
  const portableRoot = join(base, 'portable');
  const claudeSettings = join(claudeRoot, 'settings.json');
  const codexHooks = join(codexRoot, 'hooks.json');
  const copilotHooks = join(home, '.copilot', 'hooks', 'aimet.json');

  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
  mkdirSync(join(portableRoot, 'user-data', 'User'), { recursive: true });
  writeFileSync(claudeSettings, JSON.stringify({ hooks: { SessionEnd: [
    { type: 'command', command: 'aimet hook claude' },
    { hooks: [{ type: 'prompt', command: 'aimet hook claude' }] },
    { hooks: [{ type: 'command', command: 'echo aimet hook claude disabled' }] },
  ] } }));
  writeFileSync(codexHooks, JSON.stringify({ hooks: { SessionEnd: [
    { hooks: [{ type: 'command', command: 'aimet hook codex' }] },
    { type: 'prompt', command: 'aimet hook codex' },
    { type: 'command', command: 'echo aimet hook codex disabled' },
  ] } }));
  writeFileSync(copilotHooks, JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: 'command', command: 'aimet hook copilot' }] },
    { type: 'prompt', command: 'aimet hook copilot' },
    { type: 'command', command: 'echo aimet hook copilot disabled' },
  ] } }));

  initClaude(false, claudeRoot);
  initCodex(false, codexRoot);
  initCopilot(false, {
    home,
    env: { VSCODE_PORTABLE: portableRoot },
    os: platform(),
    cwd: base,
  });

  const claude = json(claudeSettings);
  const codex = json(codexHooks);
  const copilot = json(copilotHooks);
  assert.equal(nestedCommandCount(claude.hooks.SessionEnd, 'aimet hook claude'), 1);
  assert.equal(nestedCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 1);
  assert.equal(directCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 0);
  assert.equal(directCommandCount(copilot.hooks.Stop, 'aimet hook copilot'), 1);
});

test('Codex init migrates only aimet legacy hooks and Copilot honors COPILOT_HOME', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-migrate-'));
  const codexRoot = join(base, 'codex');
  const codexHooks = join(codexRoot, 'hooks.json');
  const home = join(base, 'home');
  const configuredCopilot = join(base, 'custom copilot');
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(codexHooks, JSON.stringify({ hooks: { SessionEnd: [
    { type: 'command', command: 'aimet hook codex' },
    { type: 'command', command: 'keep me' },
  ] } }));

  initCodex(false, codexRoot);
  initCopilot(false, {
    home,
    env: { COPILOT_HOME: configuredCopilot },
    os: platform(),
    cwd: base,
  });

  const codex = json(codexHooks);
  assert.equal(directCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 0);
  assert.equal(directCommandCount(codex.hooks.SessionEnd, 'keep me'), 1);
  assert.equal(nestedCommandCount(codex.hooks.SessionEnd, 'aimet hook codex'), 1);
  for (const path of [
    join(home, '.copilot', 'hooks', 'aimet.json'),
    join(configuredCopilot, 'hooks', 'aimet.json'),
  ]) {
    const cfg = json(path);
    assert.equal(cfg.version, 1);
    assert.equal(directCommandCount(cfg.hooks.Stop, 'aimet hook copilot'), 1);
    assert.equal(directCommandCount(cfg.hooks.SubagentStop, 'aimet hook copilot'), 1);
  }
});

test('normal Copilot init does not create a missing configured VS Code user directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-missing-vscode-'));
  const home = join(base, 'home');
  const portableRoot = join(base, 'missing portable');
  const output = initCopilot(false, {
    home,
    env: { VSCODE_PORTABLE: portableRoot },
    os: platform(),
    cwd: base,
  });

  assert.ok(existsSync(join(home, '.copilot', 'hooks', 'aimet.json')));
  assert.equal(existsSync(portableRoot), false);
  assert.ok(output.includes('no VS Code user dir found'));
});

test('all init targets refuse invalid JSON without overwriting it', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-init-invalid-'));
  const broken = '{ not valid json, // comment\n';

  const claudeRoot = join(base, 'claude');
  mkdirSync(claudeRoot, { recursive: true });
  const claudeSettings = join(claudeRoot, 'settings.json');
  writeFileSync(claudeSettings, broken);
  assert.throws(() => initClaude(false, claudeRoot), /not valid JSON/);
  assert.equal(readFileSync(claudeSettings, 'utf8'), broken);

  const codexRoot = join(base, 'codex');
  mkdirSync(codexRoot, { recursive: true });
  const codexHooks = join(codexRoot, 'hooks.json');
  writeFileSync(codexHooks, broken);
  assert.throws(() => initCodex(false, codexRoot), /not valid JSON/);
  assert.equal(readFileSync(codexHooks, 'utf8'), broken);

  const home = join(base, 'home');
  const copilotHooks = join(home, '.copilot', 'hooks', 'aimet.json');
  mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
  writeFileSync(copilotHooks, broken);
  assert.throws(() => initCopilot(false, { home, env: {}, os: platform(), cwd: base }), /not valid JSON/);
  assert.equal(readFileSync(copilotHooks, 'utf8'), broken);
});
