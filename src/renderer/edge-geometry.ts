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

function nativeRoute(source: EdgePoint, sourceSide: EdgeAnchor['side'], target: EdgePoint, targetSide: EdgeAnchor['side'], offset: number) {
  const positions = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
  return getSmoothStepPath({ sourceX: source.x, sourceY: source.y, sourcePosition: positions[sourceSide], targetX: target.x, targetY: target.y, targetPosition: positions[targetSide], borderRadius: 0, offset });
}

export function edgeRoute(source: EdgePoint, sourceSide: EdgeAnchor['side'], target: EdgePoint, targetSide: EdgeAnchor['side'], controlOffset?: EdgePoint): { path: string; control: EdgePoint } {
  const distance = Math.hypot(target.x - source.x, target.y - source.y), gap = distance ? Math.min(20, distance / 4) : 20;
  if (!controlOffset) {
    const [path, x, y] = nativeRoute(source, sourceSide, target, targetSide, gap);
    return { path, control: { x, y } };
  }
  const control = { x: (source.x + target.x) / 2 + controlOffset.x, y: (source.y + target.y) / 2 + controlOffset.y };
  const sourceStub = { x: source.x + directions[sourceSide].x * gap, y: source.y + directions[sourceSide].y * gap };
  const targetStub = { x: target.x + directions[targetSide].x * gap, y: target.y + directions[targetSide].y * gap };
  const betweenX = (control.x - source.x) * (control.x - target.x) <= 0, betweenY = (control.y - source.y) * (control.y - target.y) <= 0;
  const vertical = (sourceSide === 'left' || sourceSide === 'right') && betweenY || !betweenX;
  const before: EdgeAnchor['side'] = vertical ? source.y <= control.y ? 'top' : 'bottom' : source.x <= control.x ? 'left' : 'right';
  let after: EdgeAnchor['side'] = vertical ? target.y >= control.y ? 'bottom' : 'top' : target.x >= control.x ? 'right' : 'left';
  if (before === after) after = vertical ? target.x >= control.x ? 'right' : 'left' : target.y >= control.y ? 'bottom' : 'top';
  const [first] = nativeRoute(sourceStub, sourceSide, control, before, 0), [second] = nativeRoute(control, after, targetStub, targetSide, 0);
  return { path: `M${source.x} ${source.y} ${first.replace(/^M/, 'L')} ${second.replace(/^M/, 'L')} L${target.x} ${target.y}`, control };
}
