import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function runWith(options, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
}

function run(...args) {
  return runWith({}, ...args);
}

test('CLI --version prints the installed package version and exits successfully', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), pkg.version);
});

test('CLI help documents --version and exits successfully', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /aimet --version/);
  assert.match(result.stdout, /show the installed aimet version/);
});

test('detail --file requires an explicit valid tool', () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'claude-basic.jsonl');
  const missing = run('detail', '--file', fixture);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--file requires --tool/);

  const unknown = run('detail', '--tool', 'not-a-tool', '--file', fixture);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown tool/);
});

test('Copilot detail chooses the span parser from the exact log path', () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet-cli-detail-span-'));
  const dir = join(base, 'GitHub.copilot-chat', 'debug-logs', 'parent');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'runSubagent-child.jsonl');
  copyFileSync(join(import.meta.dirname, 'fixtures', 'copilot-subagent-basic.jsonl'), log);

  const result = run('detail', '--tool', 'copilot', '--file', log);
  assert.equal(result.status, 0);
  const detail = JSON.parse(result.stdout);
  assert.equal(detail.tool, 'copilot');
  assert.equal(detail.format, 'span');
});

test('hook accepts current child transcript fields and uses the exact Copilot parser', () => {
  for (const field of ['agent_transcript_path', 'transcript_path']) {
    const base = mkdtempSync(join(tmpdir(), `aimet-cli-hook-child-${field}-`));
    const dir = join(base, 'GitHub.copilot-chat', 'debug-logs', 'parent');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'runSubagent-child.jsonl');
    const db = join(base, 'metrics.db');
    copyFileSync(join(import.meta.dirname, 'fixtures', 'copilot-subagent-basic.jsonl'), log);

    const result = runWith({
      input: JSON.stringify({ [field]: log }),
      env: { ...process.env, AIMET_DB: db },
    }, 'hook', 'copilot');
    assert.equal(result.status, 0, field);

    const sqlite = new DatabaseSync(db, { readOnly: true });
    const row = sqlite.prepare(
      'SELECT session_id, parent_session_id FROM sessions'
    ).get();
    sqlite.close();
    assert.equal(row.session_id, 'call_TESTSUBAGENT01', field);
    assert.equal(row.parent_session_id, '11111111-2222-3333-4444-555555555555', field);
  }
});

test('hook failures never fail the host agent lifecycle event', () => {
  const unknown = run('hook', 'not-a-tool');
  assert.equal(unknown.status, 0);

  const base = mkdtempSync(join(tmpdir(), 'aimet-cli-hook-failure-'));
  const invalidDbTarget = join(base, 'directory-not-db');
  mkdirSync(invalidDbTarget);
  const failedStore = runWith({
    env: { ...process.env, AIMET_DB: invalidDbTarget },
    input: '{}',
  }, 'hook', 'claude');
  assert.equal(failedStore.status, 0);

  const failedCodexStore = runWith({
    env: { ...process.env, AIMET_DB: invalidDbTarget },
    input: '{}',
  }, 'hook', 'codex');
  assert.equal(failedCodexStore.status, 0);
  assert.deepEqual(JSON.parse(failedCodexStore.stdout), {});
});
