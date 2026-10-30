import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureProjectDirectory, insideProject } from '../src/core/paths.js';
import { ProviderSettingsService } from '../src/desktop/provider-settings.js';

/** Configuration evidence only: never decrypt credentials or dispatch generation. */
export function checkComfyConfiguration(args: string[]) {
  if (args.length !== 4 || args[0] !== '--project' || args[2] !== '--provider') throw Error('只读检查用法: --project PROJECT --provider CONNECTION_ID；真实生成须另行明确授权并通过原生工作流验收。');
  if (!existsSync(resolve(args[1]))) throw Error('项目目录不存在。');
  const root = ensureProjectDirectory(resolve(args[1])), file = insideProject(root, join(root, '.mixcat/state/workflow.sqlite'));
  if (!existsSync(file)) throw Error('只接受现有 Mixcat 项目。');
  const db = new DatabaseSync(file, { readOnly: true });
  let project;
  try {
    const row = db.prepare('SELECT body FROM project_state WHERE id=1').get();
    project = row && JSON.parse(String(row.body)).project;
    if (!project || project.template !== 'comfyui' || typeof project.id !== 'string' || resolve(project.root).toLowerCase() !== root.toLowerCase()) throw Error('Comfy 项目身份不匹配。');
  } finally { db.close(); }
  const forbidden = async (): Promise<never> => { throw Error('只读检查不能使用凭据。'); };
  const settings = new ProviderSettingsService({ isAsyncEncryptionAvailable: forbidden, encryptStringAsync: forbidden, decryptStringAsync: forbidden }, () => ({ owner: project, epoch: 0, snapshot: { projects: [project], selected: { project } } }), () => { throw Error('只读检查不能修改连接。'); });
  const profile = settings.listForProject(project.id).find(profile => profile.id === args[3]);
  if (!profile) throw Error('连接不存在，请在可信供应商设置中配置。');
  return { status: Object.keys(profile.models).length ? 'configured_only' : 'missing_models', liveValidated: false, projectId: project.id, connectionId: profile.id, revision: profile.revision, protocol: profile.protocol, configured: profile.configured, models: profile.models, ...(profile.videoApi ? { videoApi: profile.videoApi } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(checkComfyConfiguration(process.argv.slice(2))));
