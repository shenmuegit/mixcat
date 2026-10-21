import test from 'node:test';
import assert from 'node:assert/strict';
import { panelBounds, panelUrl, panelGeneration } from '../src/desktop/policy.js';

test('panel bounds and URL enforce the native view trust boundary', () => {
  assert.equal(panelUrl('http://127.0.0.1:1234/a'), 'http://127.0.0.1:1234/a');
  for (const url of ['file:///G:/a', 'javascript:alert(1)', 'https://user:pass@example.test']) assert.throws(() => panelUrl(url));
  assert.deepEqual(panelBounds({ x: 5, y: 10, width: 200, height: 200 }, { width: 100, height: 80 }), { x: 5, y: 10, width: 95, height: 70 });
  for (const generation of [undefined, -1, NaN, '1', 1.2]) assert.throws(() => panelGeneration(generation));
  assert.equal(panelGeneration(2), 2);
});
