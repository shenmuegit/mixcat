import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, ViewportPortal, useInternalNode, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import type { EdgeAnchor, EdgeLayout, EdgePoint, WorkflowEdge } from '../shared/types';
import { anchorPoint, anchorSides, edgeRoute, snapAnchor, type NodeBounds } from './edge-geometry';

type EditableEdge = Edge<{
  definition: WorkflowEdge; onEdit: (edge: WorkflowEdge) => void; highlighted?: boolean;
  layout?: EdgeLayout; onLayout: (edgeId: string, layout: EdgeLayout) => Promise<EdgeLayout | null>;
}, 'condition'>;
type Drag = { kind: 'source' | 'target' | 'control'; pointerId: number; start: EdgePoint; center: EdgePoint; control: EdgePoint; bounds?: NodeBounds; layout: EdgeLayout; value: EdgeLayout; moved: boolean; valid: boolean };
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
      if (active.kind === 'control') {
        active.value = { ...active.layout, controlOffset: {
          x: Math.round((active.control.x + point.x - active.start.x) / 10) * 10 - active.center.x,
          y: Math.round((active.control.y + point.y - active.start.y) / 10) * 10 - active.center.y,
        } };
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
  const center = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const { path, control } = edgeRoute(source, sourceAnchor.side, target, targetAnchor.side, layout.controlOffset);
  const label = control;
  const editing = props.selected;
  function start(event: ReactPointerEvent<Element>, kind: Drag['kind']) {
    if (event.button !== 0 || saving) return;
    event.preventDefault(); event.stopPropagation();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    const value = structuredClone(layout);
    drag.current = { kind, pointerId: event.pointerId, start: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }), center, control, bounds: kind === 'source' ? sourceBounds : kind === 'target' ? targetBounds : undefined, layout: value, value, moved: false, valid: true };
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
    <g onPointerDown={event => { if (editing) start(event, 'control'); }}><BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} /></g>
    <EdgeLabelRenderer>{!editing && labelButton}</EdgeLabelRenderer>
    {editing && <ViewportPortal>{labelButton}<div className="edge-controls" data-edge-id={data.definition.id}>
        {([['source', source], ['target', target]] as const).map(([kind, point]) => <button key={kind} className={`edge-endpoint nodrag nopan${drag.current?.kind === kind ? snapped ? ' is-snapped' : ' is-unsnapped' : ''}`} style={at(point)} aria-label={kind === 'source' ? '调整连线起点' : '调整连线终点'} title="拖动到原节点边缘吸附；方向键切换连接位置" disabled={saving} onPointerDown={event => start(event, kind)} onClick={event => event.stopPropagation()} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); keyAnchor(kind, ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1); } }} />)}
        <button className="edge-middle-control nodrag nopan" style={at(control)} aria-label="调整连线中点" title="拖动调整整条连线；方向键微调；Esc 取消" disabled={saving} onPointerDown={event => start(event, 'control')} onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            void save({ ...layout, controlOffset: { x: control.x - center.x + (event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0), y: control.y - center.y + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0) } });
          }
        }} />
        {dragging && drag.current?.bounds && anchorSides.flatMap(side => [.25, .5, .75].map(offset => <span key={`${side}-${offset}`} className="edge-snap-point" style={at(anchorPoint(drag.current!.bounds!, { side, offset }))} />))}
        {failure && <span className="edge-layout-error" role="alert" style={at({ x: label.x, y: label.y + 24 })}>连线布局未保存，请重试。</span>}
        {dragging && <span className="sr-only" role="status">{drag.current?.kind === 'control' ? '正在调整整条连线，Esc 取消' : snapped ? '已吸附到原节点' : '移到原节点边缘以吸附，松开将取消'}</span>}
      </div></ViewportPortal>}
  </>;
}
