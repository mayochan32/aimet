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
