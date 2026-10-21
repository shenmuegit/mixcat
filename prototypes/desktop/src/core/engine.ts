import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKFLOW_TOOLS, type AppCommand, type AppReply, type AppSnapshot, type CodexPort, type McpCallContext, type McpGateway, type McpIdentity, type NativeClientOptions, type NativeEvent, type NativeInput, type NodeDefinition, type PendingNativeRequest, type ProjectSnapshot, type RuntimeStatus, type WorkflowEdge, type WorkflowTool } from '../shared/types.js';
import { createCodexClient } from './codex.js';
import { createDemoClient } from './demo.js';
import { startMcpGateway } from './mcp.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import { ProjectStore } from './store.js';
import type { ProjectState, StoredNode, StoredTask } from './model.js';
import { contentText, nativeItem, recordContinuation, recordInput } from './history.js';
import { ensureSelectedPlugins, loadCapabilityCatalog } from './catalog.js';

const now = () => new Date().toISOString();
const summarySchema = { type: 'object', properties: { summary: { type: 'string', minLength: 1 } }, required: ['summary'] };
const reviewSchema = { type: 'object', properties: { summary: { type: 'string', minLength: 1 }, verdict: { enum: ['approved', 'changes_requested', 'uncertain'] } }, required: ['summary', 'verdict'] };
function text(value: unknown, name: string, limit = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`${name}不能为空，且不能超过 ${limit} 个字符。`);
  return value.trim();
}
function validatePosition(value: any): NodeDefinition['position'] {
  const x = value?.x, y = value?.y;
  if (![x, y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000)) throw new Error('节点位置不正确。');
  return { x, y };
}
function validateNode(value: any): NodeDefinition {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) throw new Error('节点标识不正确。');
  if (!Array.isArray(value.tools) || value.tools.some((t: unknown) => !WORKFLOW_TOOLS.includes(t as WorkflowTool))) throw new Error('节点工具配置不正确。');
  if (typeof value.instructions !== 'string' || value.instructions.includes('\0')) throw new Error('节点职责必须是文本。');
  const selections = (key: 'skills' | 'plugins', identifier: 'path' | 'id') => {
    const items = value[key] ?? [];
    if (!Array.isArray(items) || items.some((item: any) => !item || typeof item.name !== 'string' || !item.name.trim() || typeof item[identifier] !== 'string' || !item[identifier].trim())) throw new Error('节点能力选择不正确。');
    return items.map((item: any) => ({ name: item.name, [identifier]: item[identifier] }));
  };
  return { id: value.id, name: text(value.name, '节点名称', 80), instructions: value.instructions, tools: [...new Set<WorkflowTool>(value.tools)], resultSchema: {}, position: validatePosition(value.position), revision: Number(value.revision) || 0,
    model: value.model == null || value.model === '' ? null : text(value.model, '模型', 200), skills: selections('skills', 'path') as NodeDefinition['skills'], plugins: selections('plugins', 'id') as NodeDefinition['plugins'] };
}
function defaultNodes(): StoredNode[] {
  return [
    { id: 'plan', name: '规划', instructions: '澄清项目目标，提出可执行的工作要求。查询项目节点后，自主选择合适节点并交接。必要时可以增加一个职责明确的节点。', tools: ['get_project_context', 'handoff', 'update_workflow'], resultSchema: summarySchema, position: { x: 60, y: 160 } },
    { id: 'implement', name: '执行', instructions: '根据收到的任务完成成果。保留需求、证据和未完成项，查询节点目录，自主选择验证或审查节点交接。收到反馈时修改成果后再次交接。', tools: ['get_project_context', 'handoff'], resultSchema: summarySchema, position: { x: 380, y: 160 } },
    { id: 'review', name: '审查', instructions: '独立审查收到的成果。发现问题时向适合的节点交接具体反馈；确认目标和验收条件满足后调用 complete_task。不要把未验证内容写成已通过；无法判断时标记 blocked。', tools: ['get_project_context', 'handoff', 'complete_task'], resultSchema: reviewSchema, position: { x: 700, y: 160 } },
  ].map(n => ({ ...n, tools: n.tools as WorkflowTool[], revision: 1, threads: {}, status: 'idle' }));
}
interface Runtime { client: CodexPort; mode: 'codex' | 'demo'; status: RuntimeStatus; }
export interface EngineOptions { workbenchRoot: string; executable: string; nativeFactory?: (options: NativeClientOptions) => CodexPort; }

export class WorkflowEngine {
  private stores = new Map<string, ProjectStore>();
  private states = new Map<string, ProjectState>();
  private runtimes = new Map<string, Runtime>();
  private identities = new Map<string, McpIdentity>();
  private requests = new Map<string, PendingNativeRequest>();
  private listeners = new Set<(snapshot: AppSnapshot) => void>();
  private pumping = new Set<string>();
  private gateway!: McpGateway;
  private selectedId: string | undefined;
  private closed = false;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private catalogPath = '';
  constructor(private options: EngineOptions) {}

  async init() {
    this.options.workbenchRoot = ensureProjectDirectory(this.options.workbenchRoot);
    this.catalogPath = join(projectDirectory(this.options.workbenchRoot, '.runtime', 'workbench'), 'projects.json');
    if (existsSync(this.catalogPath)) {
      const roots: unknown = JSON.parse(readFileSync(this.catalogPath, 'utf8'));
      if (!Array.isArray(roots)) throw new Error('项目索引格式损坏。');
      for (const root of roots) {
        const store = new ProjectStore(String(root)); const state = store.read();
        if (!state) { store.close(); continue; }
        this.stores.set(state.project.id, store); this.states.set(state.project.id, state);
        const uncertain = state.tasks.filter(t => t.status === 'running' || t.status === 'needs_reconciliation');
        if (uncertain.length) {
          for (const task of uncertain) { task.status = 'needs_reconciliation'; task.error = '应用曾退出或连接中断，请先核对原生会话，再明确重试。'; }
          for (const h of state.handoffs) if (h.status === 'waiting_source') h.status = 'needs_reconciliation';
          this.activity(state, null, null, 'recovery', '发现未确认执行，已停止自动派发。');
        }
        for (const node of state.nodes) {
          if (state.tasks.some(task => task.nodeId === node.id && task.status === 'needs_reconciliation')) node.status = 'blocked';
          else if (state.tasks.some(task => task.nodeId === node.id && task.status === 'paused') || ['starting', 'running', 'pausing', 'resuming', 'queued'].includes(node.status ?? '')) node.status = 'paused';
        }
        this.updateStatus(state); store.save(state);
      }
    }
    this.gateway = await startMcpGateway({ resolveIdentity: token => this.identities.get(token), invoke: (name, args, context) => this.invokeTool(name, args, context) });
  }
  subscribe(listener: (snapshot: AppSnapshot) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private state(id: string) { const state = this.states.get(id); if (!state) throw new Error('找不到项目。'); return state; }
  private persist(state: ProjectState) { this.updateStatus(state); state.project.updatedAt = now(); this.stores.get(state.project.id)!.save(state); this.emit(); }
  private activity(state: ProjectState, nodeId: string | null, taskId: string | null, kind: string, content: string) {
    state.activities.push({ id: (state.activities.at(-1)?.id ?? 0) + 1, nodeId, taskId, kind, text: content, createdAt: now() });
  }
  private emit() {
    if (this.closed || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; const s = this.snapshot(); for (const listener of this.listeners) { try { listener(s); } catch {} } }, 60);
  }
  private snapshot(): AppSnapshot {
    const state = this.selectedId ? this.states.get(this.selectedId) : undefined;
    let selected: ProjectSnapshot | null = null;
    if (state) selected = {
      project: state.project,
      nodes: state.nodes.map(n => { const { threads, ...definition } = n; return { ...definition, threadId: threads[state.project.mode] ?? null, status: n.status ?? 'idle' }; }),
      tasks: state.tasks.map(({ nodeSnapshot, terminal, runId, nativeInput, mode, stopRequested, pauseRequested, previousTurnIds, resumeCount, ...task }) => task), handoffs: state.handoffs, activities: state.activities,
      resumeNodeIds: state.pauseSnapshot ?? [],
      edges: state.edges, conversation: [...state.conversation].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq), requests: [...this.requests.values()].filter(request => request.projectId === state.project.id),
    };
    return structuredClone({ projects: [...this.states.values()].map(s => s.project).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), selected, runtime: this.selectedId ? this.runtimes.get(this.selectedId)?.status ?? null : null });
  }
  nodeIdentity(projectId: string, nodeId: string): McpIdentity {
    const node = this.state(projectId).nodes.find(n => n.id === nodeId); if (!node) throw new Error('目标节点不存在。');
    const existing = [...this.identities.values()].find(i => i.projectId === projectId && i.nodeId === nodeId);
    if (existing) return existing;
    const identity = { token: randomBytes(32).toString('base64url'), projectId, nodeId, tools: [...node.tools], resultSchema: {} };
    this.identities.set(identity.token, identity); return identity;
  }
  private revoke(projectId: string, nodeId: string) { for (const [token, identity] of this.identities) if (identity.projectId === projectId && identity.nodeId === nodeId) this.identities.delete(token); }
  private addTask(state: ProjectState, node: StoredNode, instruction: string, input: unknown, status: StoredTask['status'] = 'queued', attempt = 1, runId = state.runId ?? randomUUID()): StoredTask {
    const { threads, ...nodeSnapshot } = node;
    const task: StoredTask = { id: randomUUID(), nodeId: node.id, instruction, status, turnId: null, threadId: null, attempt, input: structuredClone(input), result: null, error: null, createdAt: now(), finishedAt: null, runId, nodeSnapshot: structuredClone(nodeSnapshot), terminal: null, mode: state.project.mode };
    state.tasks.push(task); return task;
  }
  private saveNode(state: ProjectState, value: any, fromAgent = false, relatedTo?: string, condition = '') {
    const node = validateNode(value), existing = state.nodes.find(n => n.id === node.id);
    if (relatedTo !== undefined && (!state.nodes.some(item => item.id === relatedTo) || relatedTo === node.id || existing)) throw new Error('请选择已有节点来创建新的关联节点。');
    if (typeof condition !== 'string' || condition.includes('\0')) throw new Error('关联条件必须是文本。');
    if (state.tasks.some(t => t.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(t.status))) throw new Error('节点仍有活动或待处理任务，请处理完后修改配置。');
    if (existing && node.revision !== existing.revision) throw new Error('节点已被更新，请重新读取后再保存。');
    if (fromAgent && node.tools.includes('update_workflow')) throw new Error('Agent 不能给其他节点授予流程修改权限。');
    const next: StoredNode = { ...node, position: existing?.position ?? node.position, revision: (existing?.revision ?? 0) + 1, threads: existing?.threads ?? {}, status: existing?.status ?? 'idle' };
    if (existing) state.nodes[state.nodes.indexOf(existing)] = next; else state.nodes.push(next);
    if (relatedTo) state.edges.push({ id: randomUUID(), sourceNodeId: relatedTo, targetNodeId: node.id, condition, revision: 1 });
    this.revoke(state.project.id, node.id); this.activity(state, node.id, null, 'definition', `${existing ? '更新' : '创建'}节点「${node.name}」`); this.persist(state);
    return { nodeId: node.id, revision: next.revision };
  }
  async command(command: AppCommand): Promise<AppReply> {
    if (!command || typeof command !== 'object' || this.closed) throw new Error('应用后台不可用。');
    if (command.type === 'snapshot') { if (command.projectId) { this.state(command.projectId); this.selectedId = command.projectId; } return { snapshot: this.snapshot() }; }
    if (command.type === 'create_demo') {
      const root = projectDirectory(this.options.workbenchRoot, '.runtime', 'demo-project');
      const reply = await this.command({ type: 'create_project', name: '发布清单 · 演练项目', root, goal: '为一次产品发布制定检查清单，必须包含验证步骤和回滚方案。' });
      const state = this.state(reply.snapshot.selected!.project.id); if (state.project.status === 'idle') { state.project.mode = 'demo'; this.persist(state); }
      return { snapshot: this.snapshot() };
    }
    if (command.type === 'create_project') {
      const root = ensureProjectDirectory(command.root);
      const known = [...this.states.values()].find(s => s.project.root.toLowerCase() === root.toLowerCase());
      if (known) { this.selectedId = known.project.id; return { snapshot: this.snapshot() }; }
      const store = new ProjectStore(root); let state: ProjectState | null;
      try { state = store.read(); } catch (error) { store.close(); throw error; }
      if (!state) {
        state = { project: { id: randomUUID(), name: text(command.name, '项目名称', 100), root, goal: text(command.goal, '项目目标'), status: 'idle', mode: 'codex', updatedAt: now() }, nodes: defaultNodes(), tasks: [], handoffs: [], activities: [], edges: [], conversation: [], runId: null, maxSteps: 12 };
        store.save(state);
      }
      this.stores.set(state.project.id, store); this.states.set(state.project.id, state); this.selectedId = state.project.id;
      insideProject(this.options.workbenchRoot, this.catalogPath);
      writeFileSync(`${this.catalogPath}.tmp`, JSON.stringify([...this.states.values()].map(s => s.project.root), null, 2)); renameSync(`${this.catalogPath}.tmp`, this.catalogPath);
      this.emit(); return { snapshot: this.snapshot() };
    }
    const state = this.state(command.projectId); this.selectedId = command.projectId;
    switch (command.type) {
      case 'save_node': this.saveNode(state, command.node, false, command.relatedTo, command.condition); break;
      case 'save_edge': {
        const edge = command.edge;
        if (!edge || typeof edge.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(edge.id) || !state.nodes.some(node => node.id === edge.sourceNodeId) || !state.nodes.some(node => node.id === edge.targetNodeId) || edge.sourceNodeId === edge.targetNodeId || typeof edge.condition !== 'string' || edge.condition.includes('\0')) throw new Error('关联边配置不正确。');
        const existing = state.edges.find(item => item.id === edge.id);
        if (existing && edge.revision !== existing.revision) throw new Error('关联条件已更新，请重新读取后保存。');
        const next: WorkflowEdge = { id: edge.id, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, condition: edge.condition, revision: (existing?.revision ?? 0) + 1 };
        if (existing) state.edges[state.edges.indexOf(existing)] = next; else state.edges.push(next);
        this.persist(state); break;
      }
      case 'delete_edge': state.edges = state.edges.filter(edge => edge.id !== command.edgeId); this.persist(state); break;
      case 'catalog': { const runtime = await this.runtime(state, 'codex'); return { snapshot: this.snapshot(), catalog: await loadCapabilityCatalog(runtime.client, state.project.root) }; }
      case 'respond_native': {
        const request = this.requests.get(command.requestKey), runtime = this.runtimes.get(state.project.id);
        if (!request || request.projectId !== state.project.id || !runtime?.status.connected || !runtime.client.respond) throw new Error('原生请求已经结束或连接已断开，请刷新状态。');
        runtime.client.respond(request.id, command.result); this.requests.delete(request.key); this.emit(); break;
      }
      case 'read_history': await this.readHistory(state, command.nodeId); break;
      case 'move_node': {
        const node = state.nodes.find(n => n.id === command.nodeId); if (!node) throw new Error('目标节点不存在。');
        node.position = validatePosition(command.position); this.persist(state); break;
      }
      case 'connect': if (state.tasks.some(t => t.status === 'running')) throw new Error('请先停止或等待当前任务结束，再连接原生环境。'); await this.runtime(state, 'codex'); await this.refreshAccount(state); break;
      case 'login': {
        if (state.tasks.some(t => t.status === 'running')) throw new Error('请先停止或等待当前任务结束，再登录。');
        const runtime = await this.runtime(state, 'codex');
        const result = await runtime.client.rpc('account/login/start', { type: 'chatgpt' });
        if (!result.authUrl) throw new Error('Codex 未返回登录地址。');
        return { snapshot: this.snapshot(), authUrl: result.authUrl };
      }
      case 'send_message':
      case 'start': {
        if (!['codex', 'demo'].includes(command.mode)) throw new Error('执行模式不正确。');
        if (state.project.mode !== command.mode && state.tasks.some(t => ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(t.status))) throw new Error('请先完成当前任务，再切换执行模式。');
        const node = state.nodes.find(n => n.id === command.nodeId); if (!node) throw new Error('请选择起始节点。');
        let input: NativeInput[] | undefined;
        if (command.type === 'send_message') {
          if (!Array.isArray(command.input) || !command.input.length || command.input.some(item => !item || typeof item !== 'object' || typeof item.type !== 'string' || !item.type.trim())) throw new Error('消息必须包含原生支持的内容块。');
          input = structuredClone(command.input);
        }
        const instruction = input ? contentText(input) : text((command as Extract<AppCommand, { type: 'start' }>).instruction, '任务');
        await this.runtime(state, command.mode);
        if (command.mode === 'codex') { await this.refreshAccount(state); if (!this.runtimes.get(state.project.id)!.status.authenticated) throw new Error('请先连接并登录这个项目的 Codex。演练模式无需登录。'); }
        const runId = randomUUID();
        state.project.mode = command.mode; if (command.type === 'start') state.runId = runId; state.stopRequested = false;
        const task = this.addTask(state, node, instruction, input ?? { goal: state.project.goal }, 'queued', 1, runId);
        task.nativeInput = input;
        recordInput(state, task);
        this.activity(state, node.id, null, 'run', command.mode === 'demo' ? '开始本地演练：固定步骤验证传输与调度，不调用模型。' : '开始 Codex 原生执行。');
        this.persist(state); void this.pump(state.project.id); break;
      }
      case 'pause': {
        const retained = (state.pauseSnapshot ?? []).filter(id => state.nodes.some(node => node.id === id && ['paused', 'pausing', 'resuming'].includes(node.status ?? '')) && state.tasks.some(task => task.nodeId === id && ['running', 'paused'].includes(task.status)));
        state.pauseSnapshot = [...new Set([...retained, ...state.nodes.filter(node => state.tasks.some(task => task.nodeId === node.id && task.status === 'running')).map(node => node.id)])];
        for (const node of state.nodes) node.status = state.tasks.some(task => task.nodeId === node.id && task.status === 'running') ? 'pausing' : 'paused';
        this.persist(state);
        for (const task of state.tasks.filter(task => task.status === 'running')) this.interruptTask(state, task);
        this.activity(state, null, null, 'control', '已请求暂停项目节点；开启时只续接本次暂停的执行。'); this.persist(state); break;
      }
      case 'resume': {
        if (state.stopRequested) throw new Error('本轮已请求停止，请等待停止完成后开始新任务，或核对后明确重试。');
        for (const node of state.nodes) {
          const unfinished = state.tasks.some(task => task.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status));
          if (state.pauseSnapshot?.includes(node.id) || !unfinished) this.resumeNode(state, node);
        }
        this.activity(state, null, null, 'control', '已开启暂停时正在执行的节点；其他待处理节点保持原状。'); this.persist(state); void this.pump(state.project.id); break;
      }
      case 'pause_node':
      case 'resume_node': {
        const node = state.nodes.find(node => node.id === command.nodeId); if (!node) throw new Error('节点不存在。');
        if (command.type === 'pause_node') this.pauseNode(state, node);
        else { if (state.stopRequested) throw new Error('本轮已请求停止，请先核对停止结果。'); this.resumeNode(state, node); }
        this.activity(state, node.id, null, 'control', command.type === 'pause_node' ? '已请求暂停节点。' : node.status === 'blocked' ? '节点执行状态需处理，未重复启动任务。' : '已启用节点。'); this.persist(state); if (command.type === 'resume_node') void this.pump(state.project.id); break;
      }
      case 'stop': {
        state.stopRequested = true;
        for (const task of state.tasks.filter(task => task.status === 'running')) task.stopRequested = true;
        for (const task of state.tasks.filter(t => ['queued', 'waiting_source', 'paused'].includes(t.status))) { task.status = 'cancelled'; task.finishedAt = now(); task.error = '用户停止本轮，未派发任务已取消。'; }
        for (const h of state.handoffs.filter(h => h.status === 'queued' || h.status === 'waiting_source')) h.status = 'cancelled';
        state.pauseSnapshot = []; for (const node of state.nodes) node.status = state.tasks.some(task => task.nodeId === node.id && task.status === 'running') ? 'pausing' : 'idle';
        state.project.status = state.tasks.some(t => t.status === 'needs_reconciliation') ? 'blocked' : state.tasks.some(t => t.status === 'running') ? 'paused' : 'idle';
        this.activity(state, null, null, 'control', '已停止本轮派发，未执行任务已取消；已发生的操作仍需核对。'); this.persist(state);
        await Promise.all(state.tasks.filter(task => task.status === 'running' && !task.pauseRequested && task.turnId && task.threadId).map(task => this.runtimes.get(state.project.id)?.client.rpc('turn/interrupt', { threadId: task.threadId, turnId: task.turnId })));
        break;
      }
      case 'retry_task': {
        if (command.confirmed !== true) throw new Error('重试前需要明确确认已核对已有操作。');
        const task = state.tasks.find(t => t.id === command.taskId);
        if (!task || !['failed', 'needs_reconciliation'].includes(task.status)) throw new Error('只能重试失败或待核对的任务。');
        if (state.tasks.some(t => t.nodeId === task.nodeId && t.status === 'running')) throw new Error('节点已有正在运行的任务。');
        const runtime = await this.runtime(state, state.project.mode);
        if (task.threadId && state.project.mode === 'codex') {
          const original = await runtime.client.rpc('thread/read', { threadId: task.threadId, includeTurns: false });
          if (original.thread?.status?.type === 'active') throw new Error('原生会话仍在执行，请先停止并核对。');
        }
        for (const h of state.handoffs.filter(h => h.sourceTaskId === task.id && h.status !== 'delivered')) {
          h.status = 'cancelled'; const waiting = state.tasks.find(t => t.id === h.id); if (waiting) { waiting.status = 'cancelled'; waiting.error = '来源已明确重试，旧交接已取消。'; waiting.finishedAt = now(); }
        }
        task.status = 'failed'; task.error = '用户确认后结束本次失败尝试，后续尝试保留为独立记录。'; task.finishedAt = now();
        const node = state.nodes.find(n => n.id === task.nodeId)!;
        const next = this.addTask(state, node, `${task.instruction}\n\n用户已核对上次执行，请先检查已有成果，再继续；避免重复外部操作。`, task.input, 'queued', task.attempt + 1, task.runId);
        if (task.nativeInput) next.nativeInput = [...structuredClone(task.nativeInput), { type: 'text', text: '用户已核对上次执行，请先检查已有成果，再继续；避免重复外部操作。' }];
        recordInput(state, next);
        node.status = 'queued'; state.stopRequested = false; this.persist(state); void this.pump(state.project.id); break;
      }
      default: throw new Error('不支持的应用命令。');
    }
    return { snapshot: this.snapshot() };
  }
  private pauseNode(state: ProjectState, node: StoredNode) {
    const task = state.tasks.find(task => task.nodeId === node.id && task.status === 'running');
    node.status = task ? 'pausing' : 'paused';
    if (task) this.interruptTask(state, task);
  }
  private resumeNode(state: ProjectState, node: StoredNode) {
    if (state.tasks.some(task => task.nodeId === node.id && task.status === 'needs_reconciliation')) { node.status = 'blocked'; return; }
    const active = state.tasks.find(task => task.nodeId === node.id && task.status === 'running');
    node.status = active ? active.pauseRequested ? 'resuming' : active.turnId ? 'running' : 'starting'
      : state.tasks.some(task => task.nodeId === node.id && task.status === 'paused') ? 'resuming' : 'idle';
    this.refreshNodeStatus(state, node);
  }
  private interruptTask(state: ProjectState, task: StoredTask) {
    if (task.status !== 'running' || task.pauseRequested || !task.turnId || !task.threadId) return;
    const runtime = this.runtimes.get(state.project.id); if (!runtime?.status.connected) return;
    const turnId = task.turnId;
    task.pauseRequested = true; this.persist(state);
    void runtime.client.rpc('turn/interrupt', { threadId: task.threadId, turnId }).catch(error => {
      if (this.closed || task.status !== 'running' || task.turnId !== turnId) return;
      task.status = 'needs_reconciliation'; task.error = `暂停结果尚未确认，请核对原生会话：${error instanceof Error ? error.message : String(error)}`;
      const node = state.nodes.find(node => node.id === task.nodeId); if (node) node.status = 'blocked';
      this.activity(state, task.nodeId, task.id, 'error', task.error); this.persist(state);
    });
  }
  private async runtime(state: ProjectState, mode: 'codex' | 'demo'): Promise<Runtime> {
    const existing = this.runtimes.get(state.project.id);
    if (existing?.mode === mode && existing.status.connected) return existing;
    if (existing && existing.mode !== mode && state.tasks.some(task => ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status))) throw new Error('当前项目还有未完成任务，不能切换原生与演练环境。');
    if (existing) {
      this.runtimes.delete(state.project.id);
      for (const [key, request] of this.requests) if (request.projectId === state.project.id) this.requests.delete(key);
      await existing.client.close();
    }
    const home = projectDirectory(state.project.root, '.mixcat', 'codex');
    const options: NativeClientOptions = { executable: this.options.executable, home, cwd: state.project.root, onEvent: event => this.onNativeEvent(state.project.id, event), onDisconnect: error => this.onDisconnect(state.project.id, error), onRequest: request => {
      if (request.method === 'currentTime/read') { this.runtimes.get(state.project.id)?.client.respond?.(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
      const node = state.nodes.find(node => node.threads[mode] === request.params?.threadId);
      const key = randomUUID(); this.requests.set(key, { ...request, key, projectId: state.project.id, nodeId: node?.id ?? null }); this.emit();
    } };
    const client = mode === 'demo' ? createDemoClient(options) : (this.options.nativeFactory ?? createCodexClient)(options);
    const runtime: Runtime = { client, mode, status: { connected: false, authenticated: false, accountLabel: null, error: null, mode } };
    this.runtimes.set(state.project.id, runtime);
    try { await client.connect(); runtime.status.connected = true; this.emit(); return runtime; }
    catch (error) { runtime.status.error = String(error); this.emit(); throw error; }
  }
  private async readHistory(state: ProjectState, nodeId: string) {
    const node = state.nodes.find(node => node.id === nodeId); if (!node) throw new Error('节点不存在。');
    const threadId = node.threads[state.project.mode]; if (!threadId) return;
    const before = new Map(state.conversation.map(entry => [entry.id, JSON.stringify(entry)]));
    const runtime = await this.runtime(state, state.project.mode);
    const importItem = (turnId: string, item: any, startedAtMs?: number | null, completedAtMs?: number | null) => {
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return;
      const task = state.tasks.find(task => task.threadId === threadId && (task.turnId === turnId || task.previousTurnIds?.includes(turnId)));
      const existing = state.conversation.find(entry => (entry.threadId === threadId && entry.turnId === turnId && entry.itemId === item.id) || entry.id === `native:${threadId}:${turnId}:${item.id}` || (item.type === 'userMessage' && entry.id === `input:${task?.id}` && entry.itemId === null));
      if (existing && before.get(existing.id) !== JSON.stringify(existing)) return;
      const timestamp = typeof startedAtMs === 'number' && Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : task?.createdAt ?? '';
      const entry = nativeItem(state, node.id, threadId, turnId, item, task, completedAtMs != null || task?.status === 'completed', timestamp);
      if (completedAtMs != null) entry.completedAt = new Date(completedAtMs).toISOString();
    };
    let cursor: string | undefined; const seen = new Set<string>();
    try {
      do {
        const page = await runtime.client.rpc('thread/items/list', { threadId, sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw Object.assign(new Error('历史分页不可用。'), { code: -32601 });
        for (const entry of page.data) importItem(entry.turnId, entry.item, entry.startedAtMs, entry.completedAtMs);
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && seen.has(cursor)) throw new Error('原生历史返回了重复分页游标。');
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (error) {
      if ((error as any).code !== -32601 && !String(error).includes('Unsupported deterministic demo method')) throw error;
      const result = await runtime.client.rpc('thread/read', { threadId, includeTurns: true });
      for (const turn of result.thread?.turns ?? []) for (const item of turn.items ?? []) importItem(turn.id, item, turn.startedAt == null ? null : turn.startedAt * 1000, turn.completedAt == null ? null : turn.completedAt * 1000);
    }
    this.persist(state);
  }
  private async refreshAccount(state: ProjectState) {
    const runtime = this.runtimes.get(state.project.id)!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await runtime.client.rpc('account/read', { refreshToken: false });
        if (this.closed || this.runtimes.get(state.project.id) !== runtime) return;
        runtime.status.authenticated = !!result.account;
        runtime.status.accountLabel = result.account?.email ?? (result.account ? 'Codex 已登录' : null);
        runtime.status.error = null; this.emit(); return;
      } catch (error) {
        const routingTimeout = error instanceof Error && error.message === 'workspace routing discovery timed out';
        if (routingTimeout && attempt === 0 && runtime.status.connected && !this.closed) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (this.closed || this.runtimes.get(state.project.id) !== runtime) return;
          if (runtime.status.connected) continue;
        }
        const message = routingTimeout ? '读取 Codex 工作区路由超时，请重试连接。现有登录信息和任务记录已保留。' : error instanceof Error ? error.message : String(error);
        runtime.status.error = message; this.emit();
        if (routingTimeout) throw new Error(message, { cause: error });
        throw error;
      }
    }
  }
  private async pump(projectId: string) {
    if (this.closed) return;
    const state = this.state(projectId);
    if (state.stopRequested) return;
    await Promise.all(state.nodes.map(async node => {
      const key = `${projectId}:${node.id}`;
      if (node.status === 'paused' || node.status === 'pausing') return;
      if (this.pumping.has(key) || state.tasks.some(task => task.nodeId === node.id && ['running', 'needs_reconciliation'].includes(task.status))) return;
      const task = state.tasks.find(task => task.nodeId === node.id && task.status === 'paused') ?? state.tasks.find(task => task.nodeId === node.id && ['queued', 'waiting_source'].includes(task.status)); if (!task || !['queued', 'paused'].includes(task.status)) return;
      if (task.status !== 'paused' && !task.nativeInput && state.tasks.filter(item => item.runId === task.runId && item.threadId).length >= state.maxSteps) {
        node.status = 'blocked'; if (!state.activities.some(activity => activity.taskId === task.id && activity.kind === 'limit')) this.activity(state, task.nodeId, task.id, 'limit', `达到本次任务链 ${state.maxSteps} 轮上限，等待人工检查。`); this.persist(state); return;
      }
      this.pumping.add(key); await this.dispatch(state, node, task, key);
    }));
  }
  private async dispatch(state: ProjectState, node: StoredNode, task: StoredTask, key: string) {
    const projectId = state.project.id;
    if (task.status === 'paused' && task.turnId) { task.previousTurnIds = [...new Set([...(task.previousTurnIds ?? []), task.turnId])]; task.turnId = null; }
    const continuing = !!task.previousTurnIds?.length;
    task.status = 'running'; task.pauseRequested = false; task.error = null; task.finishedAt = null; node.status = 'starting'; this.persist(state);
    try {
      const runtime = await this.runtime(state, task.mode ?? state.project.mode);
      const identity = this.nodeIdentity(projectId, node.id);
      const config: Record<string, unknown> = { mcp_servers: { mixcat: { url: this.gateway.url, http_headers: { Authorization: `Bearer ${identity.token}` }, enabled: true, required: true, enabled_tools: identity.tools,
        default_tools_approval_mode: 'prompt', tools: Object.fromEntries(identity.tools.map(tool => [tool, { approval_mode: 'approve' }])),
        startup_timeout_sec: 20, tool_timeout_sec: 30 } } };
      const mode = task.mode ?? state.project.mode;
      if (mode === 'codex' && task.nodeSnapshot.plugins?.length) await ensureSelectedPlugins(runtime.client, state.project.root, task.nodeSnapshot.plugins);
      if (mode === 'codex' && process.platform === 'win32') {
        const readiness = await runtime.client.rpc('windowsSandbox/readiness', {});
        if (readiness.status === 'notConfigured') config['windows.sandbox'] = 'unelevated';
      }
      let threadId = node.threads[mode];
      const developerInstructions = `你是 mixcat 项目节点「${task.nodeSnapshot.name}」。\n项目目标：${state.project.goal}\n职责：${task.nodeSnapshot.instructions}\n用户可自由与本节点交流，正常回复即可完成本轮。需要其他节点协作时可以通过 mixcat MCP 查询项目并交接；不要假定固定下一步。输入输出不要求固定格式。`;
      const session = { cwd: state.project.root, config, developerInstructions, sandbox: 'workspace-write', approvalPolicy: 'on-request', ...(task.nodeSnapshot.model ? { model: task.nodeSnapshot.model } : {}) };
      let sessionResult: any;
      if (threadId) sessionResult = await runtime.client.rpc('thread/resume', { threadId, excludeTurns: true, ...session });
      else { sessionResult = await runtime.client.rpc('thread/start', session); threadId = sessionResult.thread.id; node.threads[mode] = threadId; }
      if (!threadId) throw new Error('Codex 没有返回会话标识。');
      if (mode === 'codex' && sessionResult.sandbox) {
        nativeItem(state, node.id, threadId, '', { id: `session:${task.id}`, type: 'sessionConfiguration', text: sessionResult.sandbox.type === 'readOnly' ? '原生会话当前仍为只读；文件修改能力尚未启用。' : `原生会话权限：${sessionResult.sandbox.type}；审批策略：${sessionResult.approvalPolicy ?? '原生默认'}`, cwd: sessionResult.cwd ?? state.project.root, model: sessionResult.model ?? task.nodeSnapshot.model ?? null, sandbox: sessionResult.sandbox, approvalPolicy: sessionResult.approvalPolicy, activePermissionProfile: sessionResult.activePermissionProfile ?? null }, task, true, now());
      }
      task.threadId = threadId; this.persist(state);
      if (task.stopRequested || state.stopRequested || ['pausing', 'paused'].includes(node.status) || this.closed) {
        task.status = task.stopRequested || state.stopRequested ? 'cancelled' : 'paused';
        node.status = task.status === 'paused' ? 'paused' : 'idle';
        if (task.status === 'cancelled') { task.finishedAt = now(); task.error = '用户在原生轮次启动前停止本轮。'; if (!state.tasks.some(item => item.status === 'running')) state.project.status = 'idle'; this.updateStatus(state); }
        this.persist(state); return;
      }
      const input: NativeInput[] = continuing ? [{ type: 'text', text: task.terminal
        ? '用户已启用这个暂停的节点。当前任务已有已受理的交接或完成结果，请保留该结果，仅核对当前会话并完成本轮收尾；不要重新提交交接、重新执行已经完成的工具或外部操作。'
        : '用户已启用这个暂停的节点。请基于当前会话历史继续尚未完成的任务，先核对已经执行的步骤和结果；不要从头重做，不要重复已经完成的工具或外部操作。', text_elements: [] }]
        : task.nativeInput ? structuredClone(task.nativeInput) : [{ type: 'text', text: `${task.instruction}\n\n输入交接内容：\n${JSON.stringify(task.input, null, 2)}`, text_elements: [] }];
      for (const skill of task.nodeSnapshot.skills ?? []) if (!input.some(item => item.type === 'skill' && item.path === skill.path)) input.push({ type: 'skill', name: skill.name, path: skill.path });
      for (const plugin of task.nodeSnapshot.plugins ?? []) if (!input.some(item => item.type === 'mention' && item.path === `plugin://${plugin.id}`)) input.push({ type: 'mention', name: plugin.name, path: `plugin://${plugin.id}` });
      if (continuing) { task.resumeCount = (task.resumeCount ?? 0) + 1; recordContinuation(state, task, input); this.persist(state); }
      const response = await runtime.client.rpc('turn/start', { threadId, input, ...(task.nodeSnapshot.model ? { model: task.nodeSnapshot.model } : {}) });
      const turnId = response.turn?.id; if (!turnId) throw Object.assign(new Error('原生启动结果缺少轮次，需要核对。'), { outcome: 'unknown' });
      if (task.turnId && task.turnId !== turnId) throw Object.assign(new Error('原生轮次关联发生冲突。'), { outcome: 'unknown' });
      task.turnId = turnId;
      const entry = continuing ? recordContinuation(state, task, input) : recordInput(state, task); entry.threadId = threadId; entry.turnId = turnId; entry.status = task.status;
      const incoming = state.handoffs.find(h => h.id === task.id); if (incoming) incoming.status = 'delivered';
      if (task.status === 'running') {
        if (['pausing'].includes(node.status)) this.interruptTask(state, task);
        else if (!['resuming'].includes(node.status)) node.status = 'running';
      }
      this.persist(state);
    } catch (error) {
      task.status = (error as any).outcome === 'unknown' ? 'needs_reconciliation' : 'failed'; task.error = error instanceof Error ? error.message : String(error); node.status = 'blocked'; this.updateStatus(state); this.activity(state, task.nodeId, task.id, 'error', task.error); this.persist(state);
    } finally { this.pumping.delete(key); if (task.status !== 'running') queueMicrotask(() => void this.pump(projectId)); }
  }
  private refreshNodeStatus(state: ProjectState, node: StoredNode) {
    const tasks = state.tasks.filter(task => task.nodeId === node.id);
    if (tasks.some(task => task.status === 'needs_reconciliation')) { node.status = 'blocked'; return; }
    if (node.status === 'paused' || node.status === 'pausing' || node.status === 'resuming' || node.status === 'blocked') return;
    const active = tasks.find(task => task.status === 'running');
    node.status = active ? active.turnId ? 'running' : 'starting' : tasks.some(task => task.status === 'paused') ? 'paused'
      : tasks.some(task => task.status === 'queued' || task.status === 'waiting_source') ? 'queued'
      : tasks.at(-1)?.status === 'failed' || tasks.at(-1)?.terminal?.kind === 'blocked' ? 'blocked'
      : tasks.at(-1)?.status === 'completed' ? 'completed' : 'idle';
  }
  private updateStatus(state: ProjectState) {
    for (const node of state.nodes) this.refreshNodeStatus(state, node);
    state.project.status = state.nodes.some(node => ['running', 'starting', 'resuming'].includes(node.status ?? '')) ? 'running'
      : state.nodes.some(node => node.status === 'pausing') ? 'pausing'
      : state.nodes.some(node => node.status === 'blocked') ? 'blocked'
      : state.nodes.some(node => node.status === 'queued') ? 'running'
      : state.nodes.some(node => node.status === 'paused') ? 'paused'
      : state.stopRequested || !state.tasks.length ? 'idle' : 'completed';
  }
  async invokeTool(name: WorkflowTool, args: Record<string, unknown>, context: McpCallContext): Promise<unknown> {
    const identity = this.identities.get(context.identity.token);
    if (!identity || identity.projectId !== context.identity.projectId || identity.nodeId !== context.identity.nodeId) throw new Error('MCP 身份无效或已撤销。');
    if (!identity.tools.includes(name)) throw new Error('当前节点没有调用这个工具的权限。');
    const state = this.state(identity.projectId);
    const task = state.tasks.find(t => t.nodeId === identity.nodeId && t.status === 'running' && t.threadId === context.threadId && t.turnId === context.turnId);
    if (!task) throw new Error('MCP 会话身份与当前活动执行不匹配。');
    if (name === 'get_project_context') return { project: { name: state.project.name, goal: state.project.goal, mode: state.project.mode }, task: { id: task.id, nodeId: task.nodeId, instruction: task.instruction, input: task.input, attempt: task.attempt }, nodes: state.nodes.map(n => ({ id: n.id, name: n.name, instructions: n.instructions, tools: n.tools, resultSchema: {}, position: n.position, revision: n.revision })), remainingSteps: task.nativeInput ? null : state.maxSteps - state.tasks.filter(t => t.runId === task.runId && t.threadId).length };
    if (state.stopRequested || task.stopRequested || task.pauseRequested) throw new Error('本轮正在暂停或停止，不再接受新的交接或结果提交。');
    if (name === 'update_workflow') {
      if (task.terminal) throw new Error('已提交交接，不能继续修改流程。');
      return this.saveNode(state, args.node, true);
    }
    const result = args.result;
    if (result === undefined) throw new Error('请提供交接内容。');
    const fingerprint = JSON.stringify([name, args]);
    if (task.terminal) {
      if (task.terminal.fingerprint !== fingerprint) throw new Error('本次执行已提交其他终结动作，不能重复交接不同成果。');
      return { accepted: true, handoffId: task.terminal.handoffId ?? null, status: 'waiting_source', taskId: task.id };
    }
    if (name === 'handoff') {
      const targetId = text(args.to_node_id, '目标节点', 100); const target = state.nodes.find(n => n.id === targetId);
      if (!target || target.id === task.nodeId) throw new Error('请选择项目中其他可接收任务的节点。');
      const instruction = text(args.task, '交接任务'), reason = text(args.reason, '交接理由', 4000);
      this.stores.get(identity.projectId)!.artifact(task.id, result);
      const next = this.addTask(state, target, instruction, result, 'waiting_source', 1, task.runId);
      if (task.nativeInput) next.nativeInput = [{ type: 'text', text: `${instruction}\n\n来自「${task.nodeSnapshot.name}」的内容：\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`, text_elements: [] }];
      const handoff = { id: next.id, sourceTaskId: task.id, fromNodeId: task.nodeId, toNodeId: target.id, task: instruction, reason, result: structuredClone(result), status: 'waiting_source', createdAt: now() };
      state.handoffs.push(handoff); task.result = structuredClone(result); task.terminal = { kind: 'handoff', result, fingerprint, handoffId: handoff.id };
      recordInput(state, next);
      this.activity(state, task.nodeId, task.id, 'handoff', `交接至「${target.name}」：${reason}（等待来源轮次结束）`);
    } else if (name === 'complete_task') {
      if (args.blocked !== undefined && typeof args.blocked !== 'boolean') throw new Error('blocked 必须是布尔值。');
      this.stores.get(identity.projectId)!.artifact(task.id, result);
      task.result = structuredClone(result); task.terminal = { kind: args.blocked ? 'blocked' : 'complete', result, fingerprint, reason: typeof args.reason === 'string' ? args.reason : undefined };
    } else throw new Error('不支持的工作流工具。');
    this.persist(state); return { accepted: true, handoffId: task.terminal!.handoffId ?? null, status: 'waiting_source', taskId: task.id };
  }
  private onNativeEvent(projectId: string, event: NativeEvent) {
    if (this.closed) return;
    const state = this.states.get(projectId); if (!state) return;
    const p = event.params ?? {};
    if (event.method === 'serverRequest/resolved') {
      for (const [key, request] of this.requests) if (request.projectId === projectId && request.id === p.requestId) this.requests.delete(key);
      this.emit(); return;
    }
    if (event.method === 'account/login/completed') {
      // Account lookup reports its own error; it does not imply that the live transport closed.
      if (p.success) void this.refreshAccount(state).catch(() => {});
      else { const r = this.runtimes.get(projectId); if (r) r.status.error = p.error ?? '登录未完成。'; this.emit(); }
      return;
    }
    const threadId = p.threadId;
    const turnId = p.turnId ?? p.turn?.id;
    const node = state.nodes.find(node => Object.values(node.threads).includes(threadId));
    const task = state.tasks.find(task => task.threadId === threadId && (turnId ? task.turnId === turnId : task.status === 'running'))
      ?? state.tasks.find(task => task.threadId === threadId && turnId && task.previousTurnIds?.includes(turnId))
      ?? state.tasks.find(task => task.status === 'running' && task.threadId === threadId && !task.turnId);
    if (!node) return;
    if (event.method === 'turn/started') {
      if (!task || task.status !== 'running' || task.previousTurnIds?.includes(p.turn.id)) return;
      if (!task.turnId) { task.turnId = p.turn.id; this.persist(state); }
      if (state.stopRequested || task.stopRequested) void this.runtimes.get(projectId)?.client.rpc('turn/interrupt', { threadId: task.threadId, turnId: task.turnId }).catch(error => this.onDisconnect(projectId, String(error)));
      else if (node.status === 'pausing') this.interruptTask(state, task);
      else if (node.status !== 'resuming') { node.status = 'running'; this.persist(state); }
      return;
    }
    if (task && p.turnId && task.turnId && p.turnId !== task.turnId) return;
    if (event.method === 'item/mcpToolCall/progress' && p.itemId) {
      const entry = state.conversation.find(entry => entry.threadId === threadId && entry.turnId === turnId && entry.itemId === p.itemId);
      if (entry && !entry.completedAt) { entry.content = { ...(entry.content as object), progress: p.message }; entry.text = `${contentText(entry.content)}\n${String(p.message ?? '')}`; this.persist(state); }
      return;
    }
    if ((event.method === 'item/started' || event.method === 'item/completed') && p.item?.id) {
      const completed = event.method === 'item/completed';
      if (!completed && state.conversation.some(entry => entry.threadId === threadId && entry.turnId === turnId && entry.itemId === p.item.id && (entry.completedAt || entry.status === 'completed'))) return;
      const entry = nativeItem(state, node.id, threadId, turnId ?? task?.turnId ?? '', p.item, task, completed, typeof p.startedAtMs === 'number' ? new Date(p.startedAtMs).toISOString() : now());
      if (completed && typeof p.completedAtMs === 'number') entry.completedAt = new Date(p.completedAtMs).toISOString();
      if (p.item.type !== 'agentMessage' && p.item.type !== 'userMessage') {
        const kind = `item:${p.item.id}`; const activity = state.activities.find(activity => activity.taskId === task?.id && activity.kind === kind);
        const description = `${completed ? '已完成' : '正在执行'}：${contentText(p.item)}`;
        if (activity) activity.text = description; else this.activity(state, node.id, task?.id ?? null, kind, description);
      }
      this.persist(state);
      if (p.item.type !== 'agentMessage') return;
    }
    if ((event.method.endsWith('/delta') || event.method.endsWith('Delta')) && p.itemId) {
      const previous = state.conversation.find(entry => entry.threadId === threadId && entry.turnId === (turnId ?? task?.turnId ?? '') && entry.itemId === p.itemId);
      if (previous?.completedAt || previous?.status === 'completed') return;
      const type = event.method.split('/')[1];
      const item: any = previous?.content && typeof previous.content === 'object' ? structuredClone(previous.content) : { id: p.itemId, type };
      const field = event.method.includes('outputDelta') ? 'aggregatedOutput' : 'text';
      item[field] = String(item[field] ?? '') + String(p.delta ?? '');
      const entry = nativeItem(state, node.id, threadId, turnId ?? task?.turnId ?? '', item, task, false, previous?.createdAt ?? now());
      if (field === 'aggregatedOutput') entry.text = `${contentText(item)}\n${item.aggregatedOutput}`;
      this.persist(state);
    }
    if (event.method === 'turn/plan/updated') {
      nativeItem(state, node.id, threadId, turnId ?? task?.turnId ?? '', { id: `plan:${turnId}`, type: 'plan', plan: p.plan, explanation: p.explanation }, task, false, now()); this.persist(state); return;
    }
    if (!task) return;
    if (event.method === 'item/agentMessage/delta') {
      const kind = `message:${p.itemId}`; const activity = state.activities.find(a => a.taskId === task.id && a.kind === kind);
      if (activity) activity.text += String(p.delta ?? ''); else this.activity(state, task.nodeId, task.id, kind, String(p.delta ?? ''));
      this.emit(); return;
    }
    if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
      const kind = `message:${p.item.id}`; const activity = state.activities.find(a => a.taskId === task.id && a.kind === kind);
      if (activity) activity.text = String(p.item.text ?? ''); else this.activity(state, task.nodeId, task.id, kind, String(p.item.text ?? ''));
      this.persist(state); return;
    }
    if (event.method === 'turn/completed') {
      if (p.turn?.id !== task.turnId || task.status !== 'running') return;
      task.finishedAt = now();
      for (const item of p.turn.items ?? []) if (item?.id) nativeItem(state, node.id, threadId, task.turnId!, item, task, true, now());
      const paused = p.turn.status === 'interrupted' && task.pauseRequested && !task.stopRequested && !state.stopRequested;
      if (paused) {
        task.status = 'paused'; task.finishedAt = null; task.error = null;
        if (node.status !== 'resuming') node.status = 'paused';
        this.activity(state, node.id, task.id, 'control', node.status === 'resuming' ? '原生轮次已中断，准备在原会话继续。' : '节点已暂停，原生会话和未完成任务已保留。');
      } else if (p.turn.status !== 'completed' || p.turn.error) {
        task.status = task.terminal ? 'needs_reconciliation' : 'failed'; task.error = p.turn.error?.message ?? `原生轮次${p.turn.status === 'interrupted' ? '已中断' : '失败'}，请核对成果。`;
        node.status = 'blocked';
        for (const h of state.handoffs.filter(h => h.sourceTaskId === task.id)) h.status = 'needs_reconciliation';
        this.activity(state, task.nodeId, task.id, 'error', String(task.error));
      } else {
        task.status = 'completed';
        node.status = node.status === 'pausing' && !state.stopRequested && !task.stopRequested ? 'paused' : 'idle';
        if (task.terminal?.kind === 'handoff') {
          const handoff = state.handoffs.find(h => h.id === task.terminal!.handoffId)!;
          const next = state.tasks.find(t => t.id === handoff.id)!;
          if (next.status !== 'cancelled') { next.status = 'queued'; handoff.status = 'queued'; }
          this.activity(state, task.nodeId, task.id, 'completed', next.status === 'cancelled' ? '来源工作结束，接收任务已按停止请求取消。' : '来源成果已确认，交接任务进入接收队列。');
        } else {
          if (!task.terminal) task.result = state.conversation.findLast(entry => entry.taskId === task.id && (entry.content as any)?.type === 'agentMessage')?.text ?? null;
          this.activity(state, task.nodeId, task.id, 'completed', task.terminal?.kind === 'blocked' ? task.terminal.reason ?? '需要人工处理。' : '本次会话执行完成。');
        }
      }
      task.pauseRequested = false;
      const inputEntry = state.conversation.find(entry => entry.id === (task.resumeCount ? `continuation:${task.id}:${task.resumeCount}` : `input:${task.id}`));
      if (inputEntry) { inputEntry.status = task.status; inputEntry.completedAt = task.finishedAt ?? (paused ? now() : null); }
      for (const [key, request] of this.requests) if (request.projectId === projectId && request.params?.threadId === threadId && (!request.params.turnId || request.params.turnId === task.turnId)) this.requests.delete(key);
      this.updateStatus(state);
      if (state.stopRequested && !state.tasks.some(t => ['running', 'queued', 'waiting_source', 'needs_reconciliation'].includes(t.status))) state.project.status = 'idle';
      this.persist(state); void this.pump(projectId);
    }
  }
  private onDisconnect(projectId: string, error: string) {
    if (this.closed) return;
    const runtime = this.runtimes.get(projectId); if (runtime) { runtime.status.connected = false; runtime.status.error = error; }
    const state = this.states.get(projectId); if (!state) return;
    for (const [key, request] of this.requests) if (request.projectId === projectId) this.requests.delete(key);
    const active = state.tasks.filter(t => t.status === 'running');
    for (const task of active) { task.status = 'needs_reconciliation'; task.error = error; state.project.status = 'blocked'; for (const h of state.handoffs.filter(h => h.sourceTaskId === task.id)) h.status = 'needs_reconciliation'; this.activity(state, task.nodeId, task.id, 'error', error); }
    if (active.length) this.persist(state); else this.emit();
  }
  async close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.notifyTimer);
    for (const state of this.states.values()) {
      for (const task of state.tasks.filter(t => t.status === 'running')) { task.status = 'needs_reconciliation'; task.error = '应用退出前执行尚未确认，下次启动请先核对。'; state.project.status = 'blocked'; }
      this.updateStatus(state);
      this.stores.get(state.project.id)!.save(state);
    }
    await Promise.allSettled([...this.runtimes.values()].map(r => r.client.close()));
    console.info('core shutdown: native clients closed');
    await this.gateway?.close(); for (const store of this.stores.values()) store.close(); this.identities.clear(); this.listeners.clear();
  }
}
