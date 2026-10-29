import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { insideProject } from './paths.js';
import type { ExecutionProvenance, NativeRuntimeInfo, NodeDefinition } from '../shared/types.js';

function exactFile(file: string): Buffer {
  if (!isAbsolute(file) || /(?:^|[\\/])(?:auth\.json|\.env(?:\.[^\\/]*)?|\.git)(?:[\\/]|$)/i.test(file) || /[\\/]\.mixcat[\\/]codex(?:[\\/]|$)/i.test(file)) throw new Error('Not an explicit capability file');
  for (let current = resolve(file); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Linked capability file');
    if (dirname(current) === current) break;
  }
  if (!lstatSync(file).isFile()) throw new Error('Not a capability file');
  return readFileSync(file);
}
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
export function executionProvenance(root: string, node: NodeDefinition, runtimeInfo?: NativeRuntimeInfo): ExecutionProvenance {
  return {
    requestedModel: node.model ?? null, actualModel: null, requestedReasoningEffort: node.reasoningEffort ?? null,
    native: structuredClone(runtimeInfo ?? { executable: null, version: null, initialize: null }),
    skills: (node.skills ?? []).map(skill => {
      let contentSha256 = null;
      try { if (basename(skill.path) === 'SKILL.md') contentSha256 = hash(exactFile(skill.path)); } catch {}
      return { ...skill, contentSha256 };
    }),
    plugins: (node.plugins ?? []).map(plugin => {
      const value: ExecutionProvenance['plugins'][number] = { id: plugin.id, source: null, originalSource: null, manifestPath: null, manifestVersion: null, manifestSha256: null };
      try {
        const [name, market, extra] = plugin.id.split('@');
        if (extra || !/^[\w.-]+$/.test(name) || !/^mixcat-import-[\w.-]+$/.test(market)) return value;
        const marketRoot = insideProject(root, join(root, '.mixcat', 'plugin-imports', market));
        const catalog = JSON.parse(exactFile(insideProject(root, join(marketRoot, '.claude-plugin', 'marketplace.json'))).toString('utf8'));
        const entry = catalog.plugins?.find((entry: any) => entry.name === name);
        if (!entry || typeof entry.source !== 'string') return value;
        const source = insideProject(root, resolve(marketRoot, entry.source));
        if (!source.startsWith(marketRoot + '/') && !source.startsWith(marketRoot + '\\')) return value;
        for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json']) {
          try {
            const file = insideProject(root, join(source, name)), content = exactFile(file), manifest = JSON.parse(content.toString('utf8'));
            if (manifest.name !== plugin.id.split('@')[0]) continue;
            return { ...value, source, originalSource: typeof entry.mixcatSource === 'string' ? entry.mixcatSource : null, manifestPath: file, manifestVersion: typeof manifest.version === 'string' ? manifest.version : null, manifestSha256: hash(content) };
          } catch {}
        }
      } catch {}
      return value;
    }),
  };
}
