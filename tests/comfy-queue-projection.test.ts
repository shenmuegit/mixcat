import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('queue comparison tolerates only presentation dimensions and equivalent empty widgets, including native subgraphs', async () => {
  const { queueComparison } = await import(pathToFileURL(resolve('resources/comfy/mixcat/web/queue-projection.js')).href);
  const node = { id: '3', type: 'PreviewImage', pos: [20, 30], size: [140, 26], widgets_values: null, properties: { name: 'preview' }, mode: 0, inputs: [{ link: 1 }] };
  const graph = { nodes: [node], links: [[1, '2', 0, '3', 0, 'IMAGE']], definitions: { subgraphs: [{ id: 'sg', nodes: [structuredClone(node)] }] } };
  const original = JSON.stringify(graph), changed = structuredClone(graph) as any;
  changed.nodes[0].size = [140, 246]; changed.nodes[0].widgets_values = [];
  changed.nodes[0].widgets_values_named = {};
  changed.definitions.subgraphs[0].nodes[0].size = [140, 300]; changed.definitions.subgraphs[0].nodes[0].widgets_values = [];
  changed.definitions.subgraphs[0].nodes[0].widgets_values_named = {};
  assert.equal(queueComparison(graph), queueComparison(changed)); assert.equal(JSON.stringify(graph), original);
  for (const patch of [{ pos: [21, 30] }, { widgets_values: ['real prompt'] }, { widgets_values_named: { prompt: 'changed' } }, { widgets_values_named: null }, { mode: 2 }, { type: 'Other' }, { properties: { name: 'changed' } }, { inputs: [{ link: 2 }] }]) {
    const edited = structuredClone(changed); Object.assign(edited.nodes[0], patch); assert.notEqual(queueComparison(graph), queueComparison(edited));
    const inner = structuredClone(changed); Object.assign(inner.definitions.subgraphs[0].nodes[0], patch); assert.notEqual(queueComparison(graph), queueComparison(inner));
  }
});
