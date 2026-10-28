import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeArg } from '../dist/report.js';

// parseTimeArg interprets LOCAL time; convert expectations the same way.
const iso = (y, mo, d, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

test('parseTimeArg: full 14-digit stamp', () => {
  assert.equal(parseTimeArg('20260707123456'), iso(2026, 7, 7, 12, 34, 56));
});

test('parseTimeArg: date-only pads to start of day / end of day', () => {
  assert.equal(parseTimeArg('20260707'), iso(2026, 7, 7, 0, 0, 0));
  assert.equal(parseTimeArg('20260707', true), iso(2026, 7, 7, 23, 59, 59));
});

test('parseTimeArg: hour precision pads minutes/seconds', () => {
  assert.equal(parseTimeArg('2026070709'), iso(2026, 7, 7, 9, 0, 0));
  assert.equal(parseTimeArg('2026070709', true), iso(2026, 7, 7, 9, 59, 59));
});

test('parseTimeArg: separators are tolerated, junk is rejected', () => {
  assert.equal(parseTimeArg('2026-07-07 12:34:56'), iso(2026, 7, 7, 12, 34, 56));
  assert.throws(() => parseTimeArg('2026'), /invalid time/);
  assert.throws(() => parseTimeArg('notadate'), /invalid time/);
});


test('Codex cost label states the standard-tier estimation reason', async () => {
  const { costLabel } = await import('../dist/report.js');
  assert.match(costLabel({ tool: 'codex', estimated: 1 }), /estimated: standard tier; billed tier not recorded/);
  assert.doesNotMatch(costLabel({ tool: 'claude', estimated: 0 }), /billed tier not recorded/);
});


test('Codex and Markdown report disclose the unobserved cache lifetime', async () => {
  const { costLabel } = await import('../dist/report.js');
  const { reportMd, sessionMd } = await import('../dist/markdown.js');
  const row = { tool: 'codex', model: 'gpt-6.1-terra', estimated: 1, cost_usd: .5,
    started_at: '2026-10-28T00:00:00Z', last_event_at: '2026-10-28T00:01:00Z' };
  assert.match(costLabel(row), /30m cache-write baseline.*cache TTL not recorded/);
  assert.match(sessionMd(row), /30m cache-write baseline.*cache TTL not recorded/);
  assert.match(reportMd([], {}), /30分単価.*キャッシュ保存期間/);
  assert.doesNotMatch(costLabel({ tool: 'copilot', cost_source: 'actual', cost_usd: .5 }), /cache TTL/);
});
