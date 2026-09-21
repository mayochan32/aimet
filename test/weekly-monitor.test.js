import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint, compareSources, encodeState, decodeState, main, SOURCES } from '../scripts/weekly-monitor.mjs';

test('official document hash ignores line endings and trailing whitespace', () => {
  assert.equal(fingerprint('a  \r\nb\r\n'), fingerprint('a\nb\n'));
  assert.notEqual(fingerprint('a\nb'), fingerprint('a\nc'));
});

test('weekly comparison distinguishes initial baseline and later changes', () => {
  assert.deepEqual(compareSources(null, { a: 'one' }), { firstRun: true, changed: [] });
  assert.deepEqual(compareSources({ a: 'one', b: 'two' }, { a: 'one', b: 'three', c: 'new' }), {
    firstRun: false, changed: ['b', 'c'],
  });
});

test('weekly report state survives a GitHub issue comment', () => {
  const state = { hashes: { 'https://example.com': 'a'.repeat(64) } };
  assert.deepEqual(decodeState(`report\n${encodeState(state)}`), state);
  assert.equal(decodeState('ordinary comment'), null);
  assert.equal(decodeState('<!-- aimet-weekly-monitor:v1:invalid -->'), null);
});

test('weekly runs create a mentioned, assigned issue even without document changes', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const issues = [];
  try {
    process.env.GITHUB_REPOSITORY = 'mayochan32/aimet';
    process.env.GITHUB_TOKEN = 'test-only';
    process.env.GITHUB_RUN_ID = '100';
    process.env.AIMET_MONITOR_RECIPIENT = 'mayochan32';
    process.env.AIMET_MONITOR_TEST_RESULT = 'success';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith('https://api.github.com')) {
        if (options.method === 'GET') return Response.json(issues);
        const body = JSON.parse(options.body);
        const issue = { ...body, number: issues.length + 1, created_at: `2026-09-${20 + issues.length}T00:00:00Z`, html_url: `https://github.com/mayochan32/aimet/issues/${issues.length + 1}` };
        issues.unshift(issue);
        return Response.json(issue);
      }
      const response = new Response(`Official documentation\n${'x'.repeat(600)}`, {
        headers: { 'content-type': 'text/markdown' },
      });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    };
    await main();
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].assignees, ['mayochan32']);
    assert.match(issues[0].body, /@mayochan32/);
    assert.match(issues[0].title, /初回記録/);
    assert.equal(Object.keys(decodeState(issues[0].body).hashes).length, SOURCES.length);

    process.env.GITHUB_RUN_ID = '101';
    await main();
    assert.equal(issues.length, 2);
    assert.match(issues[0].title, /変更候補なし/);
    assert.match(issues[0].body, /@mayochan32/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
