import { app } from '/scripts/app.js';

const MAX = 8 * 1024 * 1024;
const bytes = value => { const body = JSON.stringify(value); if (new TextEncoder().encode(body).byteLength > MAX) throw Error('Comfy 消息大小超过 8 MiB。'); return body; };
const digest = async body => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => ['projectId', 'instanceId', 'workflowId', 'tabId', 'revision'].every(key => a[key] === b[key]);
let metadata, epoch = 0, lease = null, initializing = false, nativeLoads = 0;
const documentId = crypto.randomUUID(), identities = new WeakMap();
function identity() {
  const workflow = app.extensionManager.workflow.activeWorkflow;
  if (!workflow) throw Error('Comfy 原生工作流尚未就绪。');
  if (!identities.has(workflow)) identities.set(workflow, crypto.randomUUID());
  return { workflow, workflowId: identities.get(workflow), tabId: workflow.path };
}
function raw() { return bytes(app.rootGraph.serialize()); }
function pathTo(graph, target, path = [], seen = new Set()) {
  if (graph === target) return path;
  if (seen.has(graph)) return null; seen.add(graph);
  for (const node of graph.nodes ?? graph._nodes ?? []) if (node.subgraph) { const found = pathTo(node.subgraph, target, [...path, String(node.subgraph.id)], seen); if (found) return found; }
  return null;
}
export async function readGraph() {
  const current = identity(), serial = raw(), sequence = epoch;
  const revision = `${documentId}:${sequence}:${await digest(serial)}`;
  if (epoch !== sequence || raw() !== serial || identity().workflow !== current.workflow) throw Error('Comfy 读取期间画布已变更。');
  const subgraphPath = pathTo(app.rootGraph, app.canvas.graph);
  if (!subgraphPath) throw Error('Comfy 子图上下文尚未同步。');
  return { observation: { projectId: metadata.projectId, instanceId: metadata.instanceId, workflowId: current.workflowId, tabId: current.tabId, revision }, workflow: JSON.parse(serial), subgraphPath, selectedNodeIds: Object.keys(app.canvas.selected_nodes ?? {}) };
}
// Shared by graph editing and the later queue adapter. No caller may replace the admitted observation.
export async function withGraphLease(expected, action) {
  if (lease || nativeLoads) throw Error('Comfy 画布正在处理另一个操作。');
  const token = {}; lease = token;
  const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'dragover', 'compositionstart', 'compositionupdate', 'compositionend'];
  for (const event of events) window.addEventListener(event, block, true);
  try {
    const view = await readGraph();
    if (!equal(view.observation, expected)) throw Error('Comfy 画布已变更。');
    const serial = bytes(view.workflow);
    if (raw() !== serial) throw Error('Comfy 画布已变更。');
    return await action({ token, view, serial, workflow: identity().workflow, epoch });
  } finally { for (const event of events) window.removeEventListener(event, block, true); if (lease === token) lease = null; }
}
async function applyGraph(request) {
  bytes(request);
  if (!request.workflow || typeof request.workflow !== 'object' || Array.isArray(request.workflow) || !Array.isArray(request.workflow.nodes)) throw Error('Comfy 工作流必须包含原生 nodes 数组。');
  return withGraphLease(request.expected, async admitted => {
    const root = app.rootGraph, configure = root.configure, createSubgraphs = root.createSubgraphs;
    let allowedRaw = admitted.serial, configured = false;
    const guard = () => { if (lease !== admitted.token || epoch !== admitted.epoch || app.rootGraph !== root || identity().workflow !== admitted.workflow || identity().tabId !== request.expected.tabId || raw() !== allowedRaw) throw Error('Comfy 原生加载前画布已变更。'); };
    root.createSubgraphs = function (...args) { guard(); const result = createSubgraphs.apply(this, args); allowedRaw = raw(); return result; };
    root.configure = function (...args) { guard(); const result = configure.apply(this, args); configured = true; allowedRaw = raw(); return result; };
    try {
      guard();
      const workflow = structuredClone(request.workflow);
      workflow.id = root.id;
      const result = await nativeLoad.call(app, workflow, false, false, admitted.workflow, { deferWarnings: true });
      if (result === false || !configured) throw Error('Comfy 原生图加载失败；请使用持久恢复点。');
      epoch++;
      return await readGraph();
    } finally { root.configure = configure; root.createSubgraphs = createSubgraphs; }
  });
}
let nativeLoad;
app.registerExtension({
  name: 'Mixcat.ProjectGraph',
  async setup() {
    if (!window.mixcatComfy) return;
    const response = await fetch('/mixcat/identity'); if (!response.ok) throw Error('Comfy 实例握手失败。');
    const { instanceId } = await response.json(); metadata = await window.mixcatComfy.connect(instanceId);
    nativeLoad = app.loadGraphData;
    app.loadGraphData = async function (...args) {
      if (lease) throw Error('Comfy 画布操作期间不能加载其他工作流。');
      epoch++; nativeLoads++;
      try { return await nativeLoad.apply(this, args); } finally { nativeLoads--; epoch++; }
    };
    window.mixcatComfy.listen(async message => {
      const reply = { type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId };
      try {
        if (message.projectId !== metadata.projectId) throw Error('Comfy 项目身份冲突。');
        const request = message.request;
        const result = request.type === 'read_graph' ? await readGraph() : request.type === 'apply_graph' ? await applyGraph(request) : (() => { throw Error('Comfy 图操作不受支持。'); })();
        bytes({ ...reply, result }); window.mixcatComfy.reply({ ...reply, result });
      } catch (error) { window.mixcatComfy.reply({ ...reply, error: String(error.message || error).slice(0, 1000) }); }
    });
  },
  async afterLoadGraph() {
    if (!metadata) return;
    if (metadata.initializeGraph && !initializing) {
      initializing = true;
      // Defer until the native workflow activation has finished before replacing its default demo.
      setTimeout(async () => {
        try {
          const loaded = await app.loadGraphData({ nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 }, true, false, app.extensionManager.workflow.activeWorkflow);
          if (loaded === false || app.rootGraph.nodes.length) throw Error('Comfy 空图初始化失败。');
          metadata.initializeGraph = false; window.mixcatComfy.ready();
        } catch (error) { console.error('Mixcat empty graph initialization failed', error); }
      }, 0);
    } else if (!metadata.initializeGraph) window.mixcatComfy.ready();
  }
});
