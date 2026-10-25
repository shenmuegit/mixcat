import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorPoint, edgeRoute, snapAnchor } from '../src/renderer/edge-geometry.js';

test('endpoints snap to the original node perimeter and nearby quarter points', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 120 };
  assert.deepEqual(snapAnchor({ x: 152, y: 96 }, bounds, 16), { side: 'top', offset: .25 });
  assert.deepEqual(snapAnchor({ x: 307, y: 160 }, bounds, 16), { side: 'right', offset: .5 });
  assert.deepEqual(snapAnchor({ x: 200, y: 99 }, bounds, 100), { side: 'top', offset: .5 });
  assert.equal(snapAnchor({ x: 200, y: 160 }, bounds, 16), null);
  assert.equal(snapAnchor({ x: 350, y: 160 }, bounds, 16), null);
  assert.deepEqual(anchorPoint(bounds, { side: 'bottom', offset: .75 }), { x: 250, y: 220 });
});

const coordinates = (path: string) => path.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)!.map(Number);

test('a single relative control follows either moved terminal and a complete translation', () => {
  const source = { x: 0, y: 0 }, target = { x: 300, y: 160 }, offset = { x: 60, y: 30 };
  const before = edgeRoute(source, 'right', target, 'left', offset);
  assert.deepEqual(before.control, { x: 210, y: 110 });
  const movedSource = edgeRoute({ x: 80, y: 40 }, 'right', target, 'left', offset);
  assert.deepEqual(movedSource.control, { x: 250, y: 130 });
  assert.notEqual(movedSource.path, before.path);
  const movedTarget = edgeRoute(source, 'right', { x: 380, y: 200 }, 'left', offset);
  assert.deepEqual(movedTarget.control, { x: 250, y: 130 });
  const translated = edgeRoute({ x: 80, y: 40 }, 'right', { x: 380, y: 200 }, 'left', offset);
  assert.deepEqual(coordinates(translated.path), coordinates(before.path).map((value, index) => value + (index % 2 ? 40 : 80)));
});

test('automatic and manually guided routes expose one control and remain orthogonal on every attachment side', () => {
  for (const sourceSide of ['top', 'right', 'bottom', 'left'] as const) for (const targetSide of ['top', 'right', 'bottom', 'left'] as const) {
    const source = { x: 0, y: 0 }, target = { x: 300, y: 160 };
    for (const offset of [undefined, { x: 50, y: 30 }, { x: 220, y: -180 }]) {
      const route = edgeRoute(source, sourceSide, target, targetSide, offset), values = coordinates(route.path);
      const points = Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
      assert.deepEqual(points[0], source); assert.deepEqual(points.at(-1), target);
      assert(points.every((point, index) => !index || point.x === points[index - 1].x || point.y === points[index - 1].y));
      assert(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
      assert(points.some((point, index) => index > 0 && (
        point.x === points[index - 1].x && point.x === route.control.x && (route.control.y - point.y) * (route.control.y - points[index - 1].y) <= 0
        || point.y === points[index - 1].y && point.y === route.control.y && (route.control.x - point.x) * (route.control.x - points[index - 1].x) <= 0
      )));
    }
  }
});

test('compact connectors retain one finite middle control', () => {
  for (const [target, side] of [[{ x: 40, y: 0 }, 'left'], [{ x: 20, y: 20 }, 'top']] as const) {
    const route = edgeRoute({ x: 0, y: 0 }, 'right', target, side);
    assert(Number.isFinite(route.control.x) && Number.isFinite(route.control.y));
  }
});
