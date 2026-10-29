import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('FeedCollections is usable as the first public feed import in a fresh process', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const { FeedCollections } = await import('./src/core/feed-collections.ts'); if (typeof FeedCollections !== 'function') throw Error('Missing public collection service');"], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
