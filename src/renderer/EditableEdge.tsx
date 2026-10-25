import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, ViewportPortal, useInternalNode, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import type { EdgeAnchor, EdgeLayout, EdgePoint, WorkflowEdge } from '../shared/types';
import { anchorPoint, anchorSides, edgePoints, moveSegment, snapAnchor, type NodeBounds } from './edge-geometry';

type EditableEdge = Edge<{
  definition: WorkflowEdge; onEdit: (edge: WorkflowEdge) => void; highlighted?: boolean;
  layout?: EdgeLayout; onLayout: (edgeId: string, layout: EdgeLayout) => Promise<EdgeLayout | null>;
}, 'condition'>;
type Drag = { kind: 'source' | 'target' | number; pointerId: number; start: EdgePoint; points: EdgePoint[]; bounds?: NodeBounds; layout: EdgeLayout; value: EdgeLayout; moved: boolean; valid: boolean };
const defaultSource: EdgeAnchor = { side: 'right', offset: .5 }, defaultTarget: EdgeAnchor = { side: 'left', offset: .5 };
const at = (point: EdgePoint) => ({ transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)` });

export function EditableEdge(props: EdgeProps<EditableEdge>) {
  const data = props.data!, flow = useReactFlow();
  const sourceNode = useInternalNode(props.source), targetNode = useInternalNode(props.target);
  const [preview, setPreview] = useState<EdgeLayout | null>(null);
  const [dragging, setDragging] = useState(false), [saving, setSaving] = useState(false), [failure, setFailure] = useState(false);
  const [snapped, setSnapped] = useState(true);
  const drag = useRef<Drag | null>(null);
  const pendingRevision = useRef<number | null>(null);
  const binding = useRef({ source: props.source, target: props.target, epoch: 0 });
  if (binding.current.source !== props.source || binding.current.target !== props.target) binding.current = { source: props.source, target: props.target, epoch: binding.current.epoch + 1 };
  const layout = preview ?? data.layout ?? { revision: 0 };
  const bounds = (node: NonNullable<typeof sourceNode>): NodeBounds => ({ ...node.internals.positionAbsolute, width: node.measured.width!, height: node.measured.height! });

  async function save(value: EdgeLayout) {
    const epoch = binding.current.epoch;
    setSaving(true); setFailure(false); setPreview(value);
    try {
      const saved = await data.onLayout(data.definition.id, value);
      if (epoch !== binding.current.epoch) return;
      if (saved) { pendingRevision.current = saved.revision; setPreview(saved); }
      else { setFailure(true); setPreview(null); setSaving(false); }
    } catch { if (epoch === binding.current.epoch) { setFailure(true); setPreview(null); setSaving(false); } }
  }
  function cancel() {
    drag.current = null;
    setDragging(false); setPreview(null); setSnapped(true);
  }
  useEffect(() => { if (drag.current && (data.layout?.revision ?? 0) > drag.current.layout.revision) cancel(); }, [data.layout?.revision]);
  useEffect(() => { cancel(); pendingRevision.current = null; setSaving(false); setFailure(false); }, [props.source, props.target]);
  useEffect(() => {
    if (pendingRevision.current !== null && (data.layout?.revision ?? 0) >= pendingRevision.current) { pendingRevision.current = null; setPreview(null); setSaving(false); }
  }, [data.layout?.revision, preview?.revision]);
  useEffect(() => { if (!props.selected) cancel(); }, [props.selected]);
  useEffect(() => () => { drag.current = null; }, []);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const active = drag.current; if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
      active.moved ||= Math.hypot(point.x - active.start.x, point.y - active.start.y) * flow.getZoom() > 3;
      if (typeof active.kind === 'number') {
        const a = active.points[active.kind], b = active.points[active.kind + 1], axis = a.y === b.y ? 'y' : 'x';
        const points = moveSegment(active.points, active.kind, a[axis] + point[axis] - active.start[axis]);
        active.value = { ...active.layout, bends: points.slice(1, -1) };
      } else {
        const anchor = snapAnchor(point, active.bounds!, 20 / flow.getZoom());
        active.valid = !!anchor; setSnapped(!!anchor);
        if (anchor) active.value = { ...active.layout, [active.kind]: anchor };
      }
      setPreview(active.value);
    };
    const up = (event: PointerEvent) => {
      const active = drag.current; if (!active || event.pointerId !== active.pointerId) return;
      const swallowClick = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallowClick, true);
      window.setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
      move(event); cancel();
      if (active.moved && active.valid) void save(active.value);
    };
    const abort = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) cancel(); };
    const blur = (event: FocusEvent) => { if (event.target === window) cancel(); };
    const leave = (event: PointerEvent) => { if (event.target === document.documentElement) cancel(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', abort, true); window.addEventListener('keydown', key, true); window.addEventListener('blur', blur, true); document.addEventListener('pointerleave', leave, true);
    return () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', abort, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur, true); document.removeEventListener('pointerleave', leave, true); };
  }, [dragging]);
  if (!sourceNode || !targetNode) return null;

  const sourceBounds = bounds(sourceNode), targetBounds = bounds(targetNode);
  const sourceAnchor = layout.source ?? defaultSource, targetAnchor = layout.target ?? defaultTarget;
  const source = anchorPoint(sourceBounds, sourceAnchor), target = anchorPoint(targetBounds, targetAnchor);
  const points = edgePoints(source, sourceAnchor.side, target, targetAnchor.side, layout.bends);
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
  const segments = points.slice(1, -2).map((a, index) => ({ a, b: points[index + 2], index: index + 1 }));
  const longest = segments.reduce<typeof segments[number] | null>((best, segment) => !best || Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) > Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y) ? segment : best, null);
  const label = longest ? { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 } : { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const editing = props.selected;
  function start(event: ReactPointerEvent<Element>, kind: Drag['kind']) {
    if (event.button !== 0 || saving) return;
    event.preventDefault(); event.stopPropagation();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    const value = structuredClone(layout);
    drag.current = { kind, pointerId: event.pointerId, start: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }), points, bounds: typeof kind === 'string' ? kind === 'source' ? sourceBounds : targetBounds : undefined, layout: value, value, moved: false, valid: true };
    setFailure(false); setDragging(true); setSnapped(true);
  }
  function keyAnchor(kind: 'source' | 'target', step: number) {
    const ports = anchorSides.flatMap(side => [.25, .5, .75].map(offset => ({ side, offset })));
    const current = kind === 'source' ? sourceAnchor : targetAnchor;
    const index = ports.findIndex(port => port.side === current.side && Math.abs(port.offset - current.offset) <= .125);
    void save({ ...layout, [kind]: ports[(Math.max(0, index) + step + ports.length) % ports.length] });
  }
  let labelY = label.y + (editing ? 20 : 0);
  if (editing) for (const node of [sourceBounds, targetBounds]) {
    if (label.x + 100 > node.x && label.x - 100 < node.x + node.width && labelY + 12 > node.y && labelY - 12 < node.y + node.height) labelY = node.y + node.height + 28;
  }
  const labelButton = <button className={`condition-label nodrag nopan${data.highlighted || editing ? ' is-highlighted' : ''}`} style={at({ x: label.x, y: labelY })} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} title={data.definition.condition || '点击设置条件'} aria-label={`编辑关联条件：${data.definition.condition || '尚未设置'}`} onClick={event => { event.stopPropagation(); data.onEdit({ ...data.definition }); }}>条件 · {data.definition.condition || '点击设置'}</button>;
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
    {editing && segments.map(segment => <path key={segment.index} className={`edge-segment-hit nodrag nopan ${segment.a.y === segment.b.y ? 'horizontal' : 'vertical'}`} data-segment-index={segment.index} d={`M${segment.a.x} ${segment.a.y} L${segment.b.x} ${segment.b.y}`} onPointerDown={event => start(event, segment.index)} />)}
    <EdgeLabelRenderer>{!editing && labelButton}</EdgeLabelRenderer>
    {editing && <ViewportPortal>{labelButton}<div className="edge-controls" data-edge-id={data.definition.id}>
        {([['source', source], ['target', target]] as const).map(([kind, point]) => <button key={kind} className={`edge-endpoint nodrag nopan${drag.current?.kind === kind ? snapped ? ' is-snapped' : ' is-unsnapped' : ''}`} style={at(point)} aria-label={kind === 'source' ? '调整连线起点' : '调整连线终点'} title="拖动到原节点边缘吸附；方向键切换连接位置" disabled={saving} onPointerDown={event => start(event, kind)} onClick={event => event.stopPropagation()} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); keyAnchor(kind, ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1); } }} />)}
        {segments.map(({ a, b, index }) => <button key={index} className={`edge-segment-control nodrag nopan ${a.y === b.y ? 'horizontal' : 'vertical'}`} style={at({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })} aria-label={`移动第 ${index} 段连线`} title="拖动调整走线；方向键微调；Esc 取消" disabled={saving} onPointerDown={event => start(event, index)} onClick={event => event.stopPropagation()} onKeyDown={event => { const axis = a.y === b.y ? 'y' : 'x'; const keys = axis === 'y' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (keys.includes(event.key)) { event.preventDefault(); event.stopPropagation(); void save({ ...layout, bends: moveSegment(points, index, a[axis] + (event.key === keys[0] ? -10 : 10)).slice(1, -1) }); } }} />)}
        {dragging && typeof drag.current?.kind === 'string' && anchorSides.flatMap(side => [.25, .5, .75].map(offset => <span key={`${side}-${offset}`} className="edge-snap-point" style={at(anchorPoint(drag.current!.bounds!, { side, offset }))} />))}
        {failure && <span className="edge-layout-error" role="alert" style={at({ x: label.x, y: label.y + 24 })}>连线布局未保存，请重试。</span>}
        {dragging && <span className="sr-only" role="status">{typeof drag.current?.kind === 'string' ? snapped ? '已吸附到原节点' : '移到原节点边缘以吸附，松开将取消' : '正在调整连线，Esc 取消'}</span>}
      </div></ViewportPortal>}
  </>;
}
