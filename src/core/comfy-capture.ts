import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { insideProject } from './paths.js';
import { COMFY_GRAPH_MAX_BYTES, comfyObject, validateComfyRequest, validateObservation } from '../shared/comfy-bridge.js';
import type { ComfyRequest, ComfyTool } from '../shared/comfy.js';

export async function captureComfyRequest(name: ComfyTool, args: Record<string, unknown>, root: string, projectId: string): Promise<{ request: ComfyRequest; capture?: { bytes: number; sha256: string } }> {
  const fields: Record<ComfyTool, string[]> = {
    get_comfy_workflow: [], apply_comfy_workflow: ['observation', 'request_id', 'workflow', 'workflow_path'], restore_comfy_workflow: ['observation', 'request_id', 'version_id', 'recovery_request_id'],
    inspect_comfy_nodes: ['node_types'], run_comfy_workflow: ['observation', 'request_id'], get_comfy_run: ['run_id'], stop_comfy_run: ['run_id', 'action'],
  };
  comfyObject(args);
  if (Object.keys(args).some(key => !fields[name].includes(key))) throw Error('Comfy 工具参数不受支持；身份由原生会话决定。');
  if (['apply_comfy_workflow', 'restore_comfy_workflow', 'run_comfy_workflow'].includes(name)) {
    validateObservation(args.observation);
    if (args.observation.projectId !== projectId) throw Error('Comfy 画布项目身份冲突。');
    if (typeof args.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.request_id)) throw Error('Comfy request_id 不正确。');
  }
  let workflow = args.workflow, capture;
  if (name === 'apply_comfy_workflow') {
    if (Object.hasOwn(args, 'workflow') === Object.hasOwn(args, 'workflow_path')) throw Error('请只提供 workflow 或 workflow_path。');
    if (Object.hasOwn(args, 'workflow_path')) {
      if (typeof args.workflow_path !== 'string' || !args.workflow_path.trim() || args.workflow_path.includes('\0')) throw Error('workflow_path 不正确。');
      const path = insideProject(root, resolve(root, args.workflow_path));
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > COMFY_GRAPH_MAX_BYTES) throw Error('Comfy 工作流必须为最多 8 MiB 的普通文件，不能使用链接。');
        const bytes = Buffer.alloc(Math.min(before.size + 1, COMFY_GRAPH_MAX_BYTES + 1));
        let length = 0;
        while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
        const after = await file.stat(), current = await lstat(insideProject(root, path));
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) throw Error('Comfy 工作流文件在捕获时发生变化，请重试。');
        const captured = bytes.subarray(0, length);
        workflow = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured));
        capture = { bytes: length, sha256: createHash('sha256').update(captured).digest('hex') };
      } finally { await file.close(); }
    }
    comfyObject(workflow);
  }
  if (name === 'inspect_comfy_nodes' && (!Array.isArray(args.node_types) || !args.node_types.length || args.node_types.length > 50 || new Set(args.node_types).size !== args.node_types.length)) throw Error('请提供 1–50 个不重复的原生节点类型。');
  const request = {
    get_comfy_workflow: { type: 'read_graph' },
    apply_comfy_workflow: { type: 'apply_graph', requestId: args.request_id, expected: args.observation, workflow },
    restore_comfy_workflow: { type: 'restore_graph', requestId: args.request_id, expected: args.observation, versionId: args.version_id, ...(args.recovery_request_id !== undefined ? { recoveryRequestId: args.recovery_request_id } : {}) },
    inspect_comfy_nodes: { type: 'inspect_nodes', nodeTypes: args.node_types },
    run_comfy_workflow: { type: 'queue_graph', requestId: args.request_id, expected: args.observation },
    get_comfy_run: { type: 'read_run', runId: args.run_id },
    stop_comfy_run: { type: 'stop_run', runId: args.run_id, action: args.action },
  }[name];
  validateComfyRequest(request);
  return { request: request as ComfyRequest, ...(capture ? { capture } : {}) };
}
