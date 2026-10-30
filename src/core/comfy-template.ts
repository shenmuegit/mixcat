import type { StoredNode } from './model.js';
import { WORKFLOW_TOOLS } from '../shared/types.js';
import { questionInstructions } from './web-product.js';

export function createComfyTemplate(): StoredNode[] {
  return [{ id: 'comfy-assistant', name: 'ComfyUI 助手', instructions: `根据用户需求搭建、运行和调试当前 ComfyUI 工作流，依据实际画布、运行状态和生成成果回答。${questionInstructions}`, tools: [...WORKFLOW_TOOLS], resultSchema: {}, position: { x: 60, y: 160 }, revision: 1, threads: {}, status: 'idle' }];
}
