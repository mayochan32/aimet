import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildExamples } from '../scripts/generate-examples.mjs';

test('committed examples match the current deterministic renderers', async () => {
  const expected = await buildExamples();
  for (const [name, content] of Object.entries(expected)) {
    const committed = readFileSync(join(import.meta.dirname, '..', 'examples', name), 'utf8');
    assert.equal(committed, content, `${name} is stale; run npm run examples`);
  }
});
