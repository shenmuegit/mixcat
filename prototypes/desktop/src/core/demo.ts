import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CodexPort, NativeClientOptions, WorkflowTool } from '../shared/types.js';

type DemoTurn = {
  id: string; rootTurnId: null; items: Record<string, unknown>[]; itemsView: 'full';
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  error: { message: string; codexErrorInfo: null; additionalDetails: null; misalignment: null } | null;
  startedAt: number; completedAt: number | null; durationMs: number | null;
};
type DemoThread = { id: string; url: URL; authorization: string; turns: DemoTurn[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function connection(config: unknown): Pick<DemoThread, 'url' | 'authorization'> {
  const entry = object(object(object(config).mcp_servers).mixcat);
  const authorization = object(entry.http_headers).Authorization;
  if (typeof entry.url !== 'string' || typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) throw new Error('Demo requires a configured Mixcat MCP connection.');
  const url = new URL(entry.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Demo MCP must use the local Mixcat gateway.');
  return { url, authorization };
}

// This is a deterministic rehearsal of the transport and workflow, with no model inference.
export function createDemoClient(options: NativeClientOptions): CodexPort {
  let connected = false;
  const threads = new Map<string, DemoThread>();
  const running = new Map<string, { turnId: string; abort: AbortController; done: Promise<void> }>();
  const emit = (method: string, params: Record<string, unknown>) => options.onEvent({ method, params });

  async function run(thread: DemoThread, turn: DemoTurn, abort: AbortController): Promise<void> {
    const started = Date.now();
    const { signal } = abort;
    const client = new Client({ name: 'mixcat-deterministic-demo', version: '0.1.0' });
    const stop = () => { void client.close().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    function message(text: string, phase: 'commentary' | 'final_answer') {
      signal.throwIfAborted();
      const item = { type: 'agentMessage', id: `demo-message-${randomUUID()}`, text, phase, memoryCitation: null, delivery: null, questions: null };
      emit('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: text });
      turn.items.push(item);
      emit('item/completed', { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
    }
    async function tool(name: WorkflowTool, args: Record<string, unknown>) {
      signal.throwIfAborted();
      const result = await client.callTool({
        name, arguments: args,
        _meta: { threadId: thread.id, 'x-codex-turn-metadata': { turn_id: turn.id }, callId: `demo-call-${randomUUID()}` },
      }, undefined, { signal });
      signal.throwIfAborted();
      if (result.isError) {
        const content = Array.isArray(result.content) ? result.content : [];
        throw new Error(content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Demo MCP tool failed.');
      }
      if (result.structuredContent) return object(result.structuredContent);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.find(item => item.type === 'text');
      if (!text || typeof text.text !== 'string') throw new Error('Demo MCP result has no structured content.');
      return object(JSON.parse(text.text));
    }
    try {
      // Let the caller persist the returned Turn ID before any tool can read or mutate state.
      await delay(150, undefined, { signal });
      emit('turn/started', { threadId: thread.id, turn: structuredClone(turn) });
      message('确定性演练：读取项目任务并执行预设流程，不调用模型。', 'commentary');
      await client.connect(new StreamableHTTPClientTransport(thread.url, { requestInit: { headers: { Authorization: thread.authorization } } }), { signal });
      const context = await tool('get_project_context', {});
      const task = object(context.task);
      const input = object(task.input);
      await delay(400, undefined, { signal });
      if (task.nodeId === 'plan') {
        const goal = object(context.project).goal;
        await tool('handoff', { to_node_id: 'implement', task: '根据规划编写发布清单，并交审查节点检查。', reason: '规划已准备好，需要实现节点形成清单。', result: { summary: `目标：${typeof goal === 'string' ? goal : '完成演练'}。步骤：整理发布清单、独立审查、根据反馈修订。` } });
        message('演练规划已提交，等待本轮成功结束后交给实现节点。', 'final_answer');
      } else if (task.nodeId === 'implement') {
        const revised = input.verdict === 'changes_requested';
        const summary = revised ? '发布清单：验证构建、备份数据、部署新版本、检查健康状态；失败时回滚到备份版本并恢复数据。' : '发布清单：验证构建、备份数据、部署新版本、检查健康状态。';
        await tool('handoff', { to_node_id: 'review', task: '审查发布清单是否包含失败后的恢复步骤。', reason: revised ? '已按审查反馈补充恢复步骤，请复审。' : '初稿完成，需要独立审查。', result: { summary } });
        message(revised ? '演练已按反馈补充回滚步骤，提交复审。' : '演练已提交清单初稿，等待审查。', 'final_answer');
      } else if (task.nodeId === 'review') {
        // shortcut: rehearsal review checks one keyword; use native mode for actual review.
        const hasRollback = typeof input.summary === 'string' && input.summary.includes('回滚');
        if (hasRollback) {
          await tool('complete_task', { result: { summary: '通过', verdict: 'approved' } });
          message('演练复审通过：清单包含回滚步骤，流程完成。', 'final_answer');
        } else {
          await tool('handoff', { to_node_id: 'implement', task: '补充发布失败时的回滚步骤，再提交复审。', reason: '清单缺少失败后的恢复步骤。', result: { summary: '缺少回滚', verdict: 'changes_requested' } });
          message('演练审查发现缺少回滚步骤，已提交返工请求。', 'final_answer');
        }
      } else throw new Error('Deterministic demo only supports the plan, implement, and review nodes.');
      await delay(350, undefined, { signal });
      turn.status = 'completed';
    } catch (error) {
      turn.status = signal.aborted ? 'interrupted' : 'failed';
      turn.error = { message: signal.aborted ? '确定性演练已中断。' : error instanceof Error ? error.message : 'Deterministic demo failed.', codexErrorInfo: null, additionalDetails: null, misalignment: null };
    } finally {
      signal.removeEventListener('abort', stop);
      await client.close().catch(() => {});
      turn.completedAt = Math.floor(Date.now() / 1000);
      turn.durationMs = Date.now() - started;
      running.delete(thread.id);
      emit('turn/completed', { threadId: thread.id, turn: structuredClone(turn) });
    }
  }

  return {
    async connect() { connected = true; },
    async rpc(method, params) {
      if (!connected) throw Object.assign(new Error('Deterministic demo is not connected.'), { outcome: 'not-sent' });
      if (method === 'account/read') return { account: { type: 'demo', label: '确定性演练（非真实推理）' }, requiresOpenaiAuth: false, workspaceRouting: null };
      if (method === 'thread/start') {
        const thread: DemoThread = { id: `demo-thread-${randomUUID()}`, ...connection(params.config), turns: [] };
        threads.set(thread.id, thread);
        return { thread: { id: thread.id, status: { type: 'idle' }, turns: [] } };
      }
      const threadId = typeof params.threadId === 'string' ? params.threadId : '';
      let thread = threads.get(threadId);
      if (method === 'thread/resume' && !thread && threadId && params.config) {
        thread = { id: threadId, ...connection(params.config), turns: [] };
        threads.set(threadId, thread);
      }
      if (!thread) throw new Error('Unknown demo thread.');
      if (method === 'thread/read' || method === 'thread/resume') {
        if (method === 'thread/resume' && params.config) Object.assign(thread, connection(params.config));
        return { thread: { id: thread.id, status: running.has(thread.id) ? { type: 'active', activeFlags: [] } : { type: 'idle' }, turns: structuredClone(thread.turns) } };
      }
      if (method === 'turn/start') {
        if (running.has(thread.id)) throw new Error('Demo thread already has an active turn.');
        const turn: DemoTurn = { id: `demo-turn-${randomUUID()}`, rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
        const abort = new AbortController();
        thread.turns.push(turn);
        running.set(thread.id, { turnId: turn.id, abort, done: run(thread, turn, abort) });
        return { turn: structuredClone(turn) };
      }
      if (method === 'turn/interrupt') {
        const active = running.get(thread.id);
        if (!active || active.turnId !== params.turnId) throw new Error('Demo turn is not active.');
        active.abort.abort();
        await active.done;
        return {};
      }
      throw new Error(`Unsupported deterministic demo method: ${method}`);
    },
    async close() {
      connected = false;
      const active = [...running.values()];
      for (const turn of active) turn.abort.abort();
      await Promise.all(active.map(turn => turn.done));
    },
  };
}
