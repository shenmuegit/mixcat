import assert from 'node:assert/strict';
import { test } from 'node:test';
import uri from 'fast-uri';
import { z } from 'zod/v4';

test('bounded arrays reject excess length before expanding element errors', () => {
  const result = z.array(z.string()).max(1).safeParse(Array(10000).fill(0));
  assert.equal(result.success, false);
  assert.deepEqual(result.error!.issues.map(issue => issue.code), ['too_big']);
});

test('URI normalization does not decode an encoded relative scheme into an executable scheme', () => {
  assert.equal(uri.normalize('%6Aavascript:alert(1)'), '%6Aavascript:alert(1)');
});
