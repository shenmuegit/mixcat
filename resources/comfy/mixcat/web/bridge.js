import { app } from '/scripts/app.js';
import { api } from '/scripts/api.js';
import { queueComparison } from './queue-projection.js';

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
async function flushGraph() {
  if (lease || nativeLoads || queuePending) throw Error('Comfy 画布仍有未完成操作。');
  // The pinned native persistence listens for graphChanged and flushes its debounce on pagehide.
  const workflow = app.extensionManager.workflow.activeWorkflow;
  workflow.changeTracker.prepareForSave();
  const serial = raw(); api.dispatchCustomEvent('graphChanged', JSON.parse(serial));
  window.dispatchEvent(new Event('pagehide'));
  if (workflow.isTemporary || workflow.isModified) {
    let saved = false;
    for (const key of Object.keys(localStorage).filter(key => key.startsWith('Comfy.Workflow.DraftIndex.v2:'))) {
      const index = JSON.parse(localStorage.getItem(key));
      for (const [id, entry] of Object.entries(index.entries ?? {})) if (entry.path === workflow.path) {
        const payload = JSON.parse(localStorage.getItem(`Comfy.Workflow.Draft.v2:${key.slice('Comfy.Workflow.DraftIndex.v2:'.length)}:${id}`) ?? 'null');
        if (payload?.data === serial) saved = true;
      }
    }
    if (!saved) throw Error('Comfy 原生草稿尚未保存；请启用工作流持久保存或保存当前工作流后重试关闭。');
  }
  return readGraph();
}
// Shared by graph editing and the later queue adapter. No caller may replace the admitted observation.
export async function withGraphLease(expected, action) {
  if (lease || nativeLoads) throw Error('Comfy 画布正在处理另一个操作。');
  const token = {}; lease = token;
  const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'dragover', 'compositionstart', 'compositionupdate', 'compositionend'];
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
let nativeLoad, nativeQueue, queuePending = false, submission = null;
async function queueGraph(request) {
  if (app.processingQueue || app.queueItems.length) throw Error('Comfy 原生队列正在处理另一个操作。');
  return withGraphLease(request.expected, async admitted => {
    const root = app.rootGraph, graphToPrompt = app.graphToPrompt, queueUpdate = app.ui.queue.update, restores = [];
    const comparison = () => queueComparison(JSON.parse(raw()));
    let allowedComparison = queueComparison(admitted.view.workflow), phase = null, prepared = null, apiActive = false;
    const guard = (checkRaw = true) => {
      if (lease !== admitted.token || epoch !== admitted.epoch || app.rootGraph !== root || identity().workflow !== admitted.workflow || identity().tabId !== request.expected.tabId || checkRaw && comparison() !== allowedComparison) throw Error('Comfy 提交期间画布或标签页已变更。');
    };
    const callbacks = (graph, seen = new Set()) => {
      if (seen.has(graph)) return; seen.add(graph);
      for (const node of graph.nodes ?? []) {
        for (const widget of node.widgets ?? []) for (const key of ['beforeQueued', 'afterQueued']) {
          const own = Object.prototype.hasOwnProperty.call(widget, key), original = widget[key];
          widget[key] = function (...args) {
            guard(phase === null);
            phase ??= key;
            return original?.apply(this, args);
          };
          restores.push(() => { if (own) widget[key] = original; else delete widget[key]; });
        }
        if (node.subgraph) callbacks(node.subgraph, seen);
      }
    };
    try {
      app.ui.queue.update = async function (...args) {
        guard(phase === null);
        // Native afterQueued/promoted seed changes finish synchronously before this awaited update.
        allowedComparison = comparison(); phase = null;
        const result = await queueUpdate.apply(this, args); guard(); return result;
      };
      callbacks(root);
      app.graphToPrompt = async function (...args) {
        guard(phase === null);
        const promise = graphToPrompt.apply(this, args);
        // graphToPrompt applies virtual nodes synchronously, then awaits widget serializers.
        allowedComparison = comparison(); phase = null;
        const value = await promise; guard(); prepared = value; return value;
      };
      submission = {
        async queue(number, data, options, original) {
          guard(); if (apiActive || prepared !== data) throw Error('Comfy 提交必须经过原生图准备。');
          apiActive = true; prepared = null;
          try { return await original.call(api, number, data, options); } finally { apiActive = false; }
        },
        async post(options) {
          guard(); if (!apiActive || typeof options?.body !== 'string') throw Error('Comfy 提交尚未准备。');
          const payload = JSON.parse(options.body); bytes(payload);
          if (payload.extra_data?.auth_token_comfy_org || payload.extra_data?.api_key_comfy_org) throw Error('此项目仅支持本地节点和已配置的 BYOK 连接，不支持 Comfy 账户凭据。');
          delete payload.extra_data.auth_token_comfy_org; delete payload.extra_data.api_key_comfy_org;
          const response = await window.mixcatComfy.admit(request.sessionId, admitted.view.observation, payload);
          guard();
          return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        }
      };
      guard();
      const ok = await nativeQueue.call(app, request.queue.number, request.queue.batchCount, request.queue.options);
      guard(); return { ok };
    } finally {
      submission = null; phase = null; app.graphToPrompt = graphToPrompt; app.ui.queue.update = queueUpdate;
      for (const restore of restores.reverse()) restore();
      // No queued native item may outlive the durable submission session.
      app.queueItems.length = 0;
    }
  });
}
app.registerExtension({
  name: 'Mixcat.ProjectGraph',
  async setup() {
    if (!window.mixcatComfy) return;
    const response = await fetch('/mixcat/identity'); if (!response.ok) throw Error('Comfy 实例握手失败。');
    const { instanceId, admission } = await response.json(); if (admission !== true) throw Error('Comfy 后端受理保护未就绪。'); metadata = await window.mixcatComfy.connect(instanceId);
    if (metadata.initializeGraph) await app.ui.settings.setSettingValue('Comfy.TutorialCompleted', true);
    nativeLoad = app.loadGraphData;
    app.loadGraphData = async function (...args) {
      if (lease) throw Error('Comfy 画布操作期间不能加载其他工作流。');
      epoch++; nativeLoads++;
      try { return await nativeLoad.apply(this, args); } finally { nativeLoads--; epoch++; }
    };
    nativeQueue = app.queuePrompt;
    const nativeApiQueue = api.queuePrompt, nativeFetch = api.fetchApi;
    app.queuePrompt = async function (number, batchCount = 1, options = {}) {
      if (queuePending || lease) throw Error('Comfy 画布正在处理另一个操作。');
      queuePending = true;
      try {
        const view = await readGraph();
        const result = await window.mixcatComfy.queue({ type: 'queue_graph', requestId: crypto.randomUUID(), expected: view.observation }, { number, batchCount, options: Array.isArray(options) ? { queueNodeIds: options } : options });
        return result.ok;
      } finally { queuePending = false; }
    };
    api.queuePrompt = function (number, data, options) { if (!submission) return Promise.reject(Error('Comfy 提交必须经过原生队列受理。')); return submission.queue(number, data, options, nativeApiQueue); };
    api.fetchApi = function (route, options, ...rest) {
      if ((route === '/prompt' || route === '/api/prompt') && options?.method === 'POST') {
        if (!submission) return Promise.reject(Error('Comfy 提交必须经过原生队列受理。'));
        return submission.post(options);
      }
      return nativeFetch.call(this, route, options, ...rest);
    };
    api.addEventListener('mixcat.connections', async () => {
      // Native combo refresh must not silently replace a removed connection with another credential.
      const saved = [], seen = new Set();
      const visit = graph => { if (seen.has(graph)) return; seen.add(graph); for (const node of graph.nodes ?? []) { if (/^MixcatAPI/.test(node.type)) { const widget = node.widgets?.find(widget => widget.name === 'connection'); if (widget) saved.push([widget, widget.value]); } if (node.subgraph) visit(node.subgraph); } };
      visit(app.rootGraph);
      try { await app.reloadNodeDefs(); } finally { for (const [widget, value] of saved) widget.value = value; }
    });
    window.mixcatComfy.listen(async message => {
      const reply = { type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId };
      try {
        if (message.projectId !== metadata.projectId) throw Error('Comfy 项目身份冲突。');
        const request = message.request;
        const result = request.type === 'read_graph' ? await readGraph() : request.type === 'flush_graph' ? await flushGraph() : request.type === 'apply_graph' ? await applyGraph(request) : request.type === 'native_queue' ? await queueGraph(request) : (() => { throw Error('Comfy 图操作不受支持。'); })();
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
