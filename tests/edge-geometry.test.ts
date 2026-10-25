import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorPoint, edgePoints, moveSegment, snapAnchor } from '../src/renderer/edge-geometry.js';

test('endpoints snap to the original node perimeter and nearby quarter points', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 120 };
  assert.deepEqual(snapAnchor({ x: 152, y: 96 }, bounds, 16), { side: 'top', offset: .25 });
  assert.deepEqual(snapAnchor({ x: 307, y: 160 }, bounds, 16), { side: 'right', offset: .5 });
  assert.deepEqual(snapAnchor({ x: 200, y: 99 }, bounds, 100), { side: 'top', offset: .5 });
  assert.equal(snapAnchor({ x: 200, y: 160 }, bounds, 16), null);
  assert.equal(snapAnchor({ x: 350, y: 160 }, bounds, 16), null);
  assert.deepEqual(anchorPoint(bounds, { side: 'bottom', offset: .75 }), { x: 250, y: 220 });
});

test('dragging a middle segment keeps endpoint stubs fixed and every segment orthogonal', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 180, y: 80 }, { x: 200, y: 80 }];
  assert.deepEqual(moveSegment(points, 2, 143), [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 80 }, { x: 180, y: 80 }, { x: 200, y: 80 }]);
  assert.deepEqual(moveSegment(points, 1, 42), [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 40 }, { x: 100, y: 40 }, { x: 100, y: 80 }, { x: 180, y: 80 }, { x: 200, y: 80 }]);
  assert.deepEqual(points[2], { x: 100, y: 0 });
});

test('compact straight and L-shaped connectors retain a draggable middle segment', () => {
  for (const [target, targetSide] of [[{ x: 40, y: 0 }, 'left'], [{ x: 20, y: 20 }, 'top']] as const) {
    const points = edgePoints({ x: 0, y: 0 }, 'right', target, targetSide);
    assert(points.length >= 4, 'A compact connector needs an interior segment');
    const axis = points[1].y === points[2].y ? 'y' : 'x';
    const moved = moveSegment(points, 1, points[1][axis] + 30);
    assert.notDeepEqual(moved, points);
    assert.deepEqual(moved[0], { x: 0, y: 0 }); assert.deepEqual(moved.at(-1), target);
  }
});

test('manual orthogonal routes remain attached after moving nodes or switching attachment sides', () => {
  for (const sourceSide of ['top', 'right', 'bottom', 'left'] as const) for (const targetSide of ['top', 'right', 'bottom', 'left'] as const) {
    const source = { x: 0, y: 0 }, target = { x: 300, y: 160 };
    for (const bends of [undefined, [{ x: 20, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 200 }, { x: 280, y: 200 }]]) {
      const points = edgePoints(source, sourceSide, target, targetSide, bends);
      assert.deepEqual(points[0], source); assert.deepEqual(points.at(-1), target);
      assert(points.every((point, index) => !index || point.x === points[index - 1].x || point.y === points[index - 1].y));
      assert(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    }
  }
});
