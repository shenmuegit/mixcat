export const WORKFLOW_STORAGE_PATH = '/system_stats';

export interface WorkflowBrowserStorage {
  local: Record<string, string>;
  session: Record<string, string>;
}

export interface SavedWorkflowTabs {
  paths: string[];
  activePath: string | null;
}

const oldKeys = ['Comfy.OpenWorkflowsPaths', 'Comfy.ActiveWorkflowIndex', 'Comfy.PreviousWorkflow', 'workflow'];

export function isWorkflowStorageKey(key: string) {
  return key.startsWith('Comfy.Workflow.') || oldKeys.some(old => key === old || key.startsWith(`${old}:`));
}

function workflowPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('workflows/') && value.length <= 1024;
}

export function savedPathsFromLegacy(storage: WorkflowBrowserStorage): SavedWorkflowTabs | undefined {
  const entries = [...Object.entries(storage.session), ...Object.entries(storage.local)];
  for (const [key, value] of entries) {
    if (!/^Comfy\.(?:Workflow\.(?:Last)?OpenPaths:|OpenWorkflowsPaths(?::|$))/.test(key)) continue;
    try {
      const pointer = JSON.parse(value);
      const paths: unknown = Array.isArray(pointer) ? pointer : pointer?.paths;
      if (!Array.isArray(paths)) continue;
      const active = paths[pointer?.activeIndex];
      const named = [...new Set(paths.filter(workflowPath))].slice(0, 1000);
      if (named.length) return { paths: named, activePath: workflowPath(active) ? active : named[0] };
    } catch { /* A malformed pointer is archived with the rest of the legacy data. */ }
  }
  for (const [key, value] of entries) {
    if (!/^Comfy\.Workflow\.(?:Last)?ActivePath:/.test(key)) continue;
    try {
      const path: unknown = JSON.parse(value)?.path;
      if (workflowPath(path)) return { paths: [path], activePath: path };
    } catch { /* A malformed pointer is archived with the rest of the legacy data. */ }
  }
}
