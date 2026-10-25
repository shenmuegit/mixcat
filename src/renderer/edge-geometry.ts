import { getSmoothStepPath, Position } from '@xyflow/react';
import type { EdgeAnchor, EdgePoint } from '../shared/types';

export const anchorSides: EdgeAnchor['side'][] = ['top', 'right', 'bottom', 'left'];
export type NodeBounds = EdgePoint & { width: number; height: number };
const directions = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

export function anchorPoint(bounds: NodeBounds, anchor: EdgeAnchor): EdgePoint {
  return anchor.side === 'top' || anchor.side === 'bottom'
    ? { x: bounds.x + bounds.width * anchor.offset, y: bounds.y + (anchor.side === 'bottom' ? bounds.height : 0) }
    : { x: bounds.x + (anchor.side === 'right' ? bounds.width : 0), y: bounds.y + bounds.height * anchor.offset };
}

export function snapAnchor(point: EdgePoint, bounds: NodeBounds, radius: number): EdgeAnchor | null {
  let nearest: EdgeAnchor | null = null, distance = radius;
  for (const side of anchorSides) {
    const horizontal = side === 'top' || side === 'bottom';
    const size = horizontal ? bounds.width : bounds.height;
    let offset = Math.max(0, Math.min(1, ((horizontal ? point.x - bounds.x : point.y - bounds.y) / size)));
    const snap = [.25, .5, .75].reduce((nearest, candidate) => Math.abs(candidate - offset) < Math.abs(nearest - offset) ? candidate : nearest);
    if (Math.abs(snap - offset) * size < radius * .75) offset = snap;
    const anchor = { side, offset }, target = anchorPoint(bounds, anchor);
    const nextDistance = Math.hypot(point.x - target.x, point.y - target.y);
    if (nextDistance <= distance) { nearest = anchor; distance = nextDistance; }
  }
  return nearest;
}

function distinct(points: EdgePoint[]): EdgePoint[] {
  return points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

export function edgePoints(source: EdgePoint, sourceSide: EdgeAnchor['side'], target: EdgePoint, targetSide: EdgeAnchor['side'], bends?: EdgePoint[]): EdgePoint[] {
  if (!bends?.length) {
    const positions = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
    const [path] = getSmoothStepPath({ sourceX: source.x, sourceY: source.y, sourcePosition: positions[sourceSide], targetX: target.x, targetY: target.y, targetPosition: positions[targetSide], borderRadius: 0 });
    // Zero-radius Q commands repeat the same corner; keep one copy of each point.
    const coordinates = path.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)!.map(Number);
    return distinct(Array.from({ length: coordinates.length / 2 }, (_, index) => ({ x: coordinates[index * 2], y: coordinates[index * 2 + 1] })));
  }
  const sourceStub = { x: source.x + directions[sourceSide].x * 20, y: source.y + directions[sourceSide].y * 20 };
  const targetStub = { x: target.x + directions[targetSide].x * 20, y: target.y + directions[targetSide].y * 20 };
  const points = [source, sourceStub];
  for (const point of [...bends, targetStub]) {
    const previous = points.at(-1)!;
    if (previous.x !== point.x && previous.y !== point.y) points.push({ x: previous.x, y: point.y });
    points.push(point);
  }
  return distinct([...points, target]);
}

export function moveSegment(points: EdgePoint[], index: number, coordinate: number): EdgePoint[] {
  if (index < 1 || index >= points.length - 2) return points;
  const a = points[index], b = points[index + 1], axis = a.y === b.y ? 'y' : 'x';
  const value = Math.round(coordinate / 10) * 10;
  return distinct([
    ...points.slice(0, index),
    ...(index === 1 || points[index - 1][axis] === a[axis] ? [a] : []),
    { ...a, [axis]: value }, { ...b, [axis]: value },
    ...(index === points.length - 3 || points[index + 2][axis] === b[axis] ? [b] : []),
    ...points.slice(index + 2),
  ]);
}
