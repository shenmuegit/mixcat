import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { createServer } from 'node:net';
import { ComfyStore } from './comfy-store.js';
import { prepareRuntime, type PreparationIO, type RuntimeManifest } from './comfy-runtime.js';
export { lifecycleLease } from './comfy-runtime.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export interface NativeWorkspace {
  local: Record<string, string>; session: Record<string, string>;
  tabs: { path: string; workflow: Record<string, unknown>; initialState: Record<string, unknown>; temporary: boolean; modified: boolean }[];
  active: { path: string; subgraphPath: string[]; selectedNodeIds: string[] } | null;
}
export interface RuntimeSelection { versionId: string; generationId: string; data: string; browser: string; home: string; port: number; graphInitialized: boolean; workspace?: NativeWorkspace; }
export interface RuntimeCombination { versionId: string; manifest: RuntimeManifest; extensions: Record<string, string>; directory: string; protocol: 1; }
export interface RuntimeCandidate { selection: RuntimeSelection; source: RuntimeSelection; checkpoint: RuntimeSelection; sourceHash: string; sourceParts?: Record<string, string>; qualifiedAt: string; }
export interface UpdateDriver {
  // Fences admission, flushes every native draft and drains known facts before stopping.
  checkpoint(): Promise<NativeWorkspace>;
  start(selection: RuntimeSelection, combination: RuntimeCombination): Promise<void>;
  stop(): Promise<void>;
  qualify(selection: RuntimeSelection, combination: RuntimeCombination): Promise<void>;
}
export const extensionFiles = ['__init__.py', 'nodes.py', 'web/bridge.js', 'web/queue-projection.js'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function files(root: string, directory: string, sharedModels = insideProject(root, join(root, '.mixcat', 'comfy', 'data', 'models'))): string[] {
  insideProject(root, directory);
  if (directory === sharedModels) return [];
  return readdirSync(directory).sort().flatMap(name => {
    const path = insideProject(root, join(directory, name)), stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Comfy 数据不能包含链接。');
    return stat.isDirectory() ? files(root, path, sharedModels) : stat.isFile() ? [path] : (() => { throw Error('Comfy 数据文件类型不受支持。'); })();
  });
}
function copyTree(root: string, source: string, destination: string) {
  for (const file of files(root, source)) { const target = insideProject(root, join(destination, relative(source, file))), stat = lstatSync(file); projectDirectory(root, relative(root, dirname(target))); copyFileSync(file, target); utimesSync(target, stat.atimeMs / 1000, stat.mtimeMs / 1000); }
}
export function workspaceContent(workspace: NativeWorkspace) {
  const graph = (value: Record<string, unknown>) => { const copy = structuredClone(value); if (copy.extra && typeof copy.extra === 'object') delete (copy.extra as Record<string, unknown>).ds; return copy; };
  return { tabs: workspace.tabs.map(tab => ({ ...tab, workflow: graph(tab.workflow), initialState: graph(tab.initialState) })), active: workspace.active };
}
function browserContent(workspace: NativeWorkspace) {
  const local = structuredClone(workspace.local); delete local['Comfy.FeatureUsage'];
  for (const key of Object.keys(local)) {
    if (!key.startsWith('Comfy.Workflow.Draft')) continue;
    const value = JSON.parse(local[key]); delete value.updatedAt;
    if (value.entries) for (const entry of Object.values(value.entries) as Record<string, unknown>[]) delete entry.updatedAt;
    if (key.startsWith('Comfy.Workflow.DraftIndex.v2:')) {
      if (!Array.isArray(value.order) || value.order.some((id: unknown) => typeof id !== 'string') || JSON.stringify([...value.order].sort()) !== JSON.stringify(Object.keys(value.entries ?? {}).sort())) throw Error('Comfy 草稿索引与条目不匹配。');
      value.order.sort(); // Native saveDraft touches cache LRU; tab order is bound separately by OpenPaths/tabs.
    }
    if (typeof value.data === 'string') { const graph = JSON.parse(value.data); if (graph.extra) delete graph.extra.ds; value.data = JSON.stringify(graph); }
    local[key] = JSON.stringify(value);
  }
  const session = { ...workspace.session }, client = session.clientId; delete session.clientId;
  for (const key of Object.keys(session)) if (/^Comfy\.Workflow\.(ActivePath|OpenPaths):/.test(key)) delete session[key];
  for (const name of ['ActivePath', 'OpenPaths']) if (workspace.session[`Comfy.Workflow.${name}:${client}`] !== undefined) session[`Comfy.Workflow.${name}`] = workspace.session[`Comfy.Workflow.${name}:${client}`];
  return { local, session };
}
export function verifyCombination(root: string, combination: RuntimeCombination) {
  const identity = { manifest: combination.manifest, extensions: combination.extensions, protocol: combination.protocol };
  if (combination.versionId !== hash(JSON.stringify(identity)) || combination.protocol !== 1 || Object.keys(combination.extensions).join('|') !== extensionFiles.join('|')) throw Error('Comfy 完整组合身份不匹配。');
  for (const file of extensionFiles) if (hash(readFileSync(insideProject(root, join(root, combination.directory, file)))) !== combination.extensions[file]) throw Error('Comfy 扩展校验失败。');
}
export function installCombination(root: string, selection: RuntimeSelection, combination: RuntimeCombination) {
  verifyCombination(root, combination);
  for (const file of extensionFiles) {
    const target = insideProject(root, join(root, selection.data, 'custom_nodes', 'mixcat', file));
    projectDirectory(root, relative(root, dirname(target)));
    if (existsSync(target) && lstatSync(target).nlink !== 1) throw Error('Comfy 扩展目标不能是硬链接。');
    copyFileSync(insideProject(root, join(root, combination.directory, file)), target);
  }
}
export function verifyInstalledCombination(root: string, selection: RuntimeSelection, combination: RuntimeCombination) {
  verifyCombination(root, combination);
  for (const file of extensionFiles) if (hash(readFileSync(insideProject(root, join(root, selection.data, 'custom_nodes', 'mixcat', file)))) !== combination.extensions[file]) throw Error('Comfy 已加载扩展文件与选定组合不匹配。');
}
export class ComfyUpdates {
  constructor(readonly store: ComfyStore, private assets: string, private driver: UpdateDriver, private io?: PreparationIO) {}
  selection(): RuntimeSelection { const value = this.store.runtimeRecord<RuntimeSelection>('selection'); if (!value) throw Error('Comfy 尚未选择完整运行组合。'); return value; }
  combination(id: string): RuntimeCombination { const value = this.store.runtimeRecord<RuntimeCombination>('combination:' + id); if (!value) throw Error('Comfy 完整运行组合不存在。'); verifyCombination(this.store.root, value); return value; }
  candidates(): RuntimeCandidate[] { return this.store.runtimeRecord<RuntimeCandidate[]>('candidates') ?? []; }
  private pin(manifest: RuntimeManifest): RuntimeCombination {
    const extensions = Object.fromEntries(extensionFiles.map(file => [file, hash(readFileSync(join(this.assets, 'mixcat', file)))]));
    const identity = { manifest, extensions, protocol: 1 as const }, versionId = hash(JSON.stringify(identity));
    const directory = relative(this.store.root, projectDirectory(this.store.root, '.mixcat', 'comfy', 'combinations', versionId));
    const combination = { ...identity, versionId, directory };
    for (const file of extensionFiles) {
      const target = insideProject(this.store.root, join(this.store.root, directory, file));
      if (existsSync(target)) { if (hash(readFileSync(target)) !== extensions[file]) throw Error('Comfy 不可变扩展已损坏。'); }
      else { projectDirectory(this.store.root, relative(this.store.root, dirname(target))); copyFileSync(join(this.assets, 'mixcat', file), target); }
    }
    this.store.saveRuntimeRecords({ ['combination:' + versionId]: combination }); return combination;
  }
  initialize(manifest: RuntimeManifest): RuntimeSelection {
    const existing = this.store.runtimeRecord<RuntimeSelection>('selection'); if (existing) { this.combination(existing.versionId); return existing; }
    const combination = this.pin(manifest), root = this.store.root;
    const selection: RuntimeSelection = { versionId: combination.versionId, generationId: 'legacy', data: relative(root, projectDirectory(root, '.mixcat', 'comfy', 'data')), browser: relative(root, projectDirectory(root, '.mixcat', 'comfy', 'browser')), home: '.mixcat/comfy', port: this.store.getRuntimePort() ?? 0, graphInitialized: this.store.graphInitialized() };
    this.store.saveRuntimeRecords({ selection }); return selection;
  }
  private async clone(source: RuntimeSelection, versionId: string, workspace: NativeWorkspace): Promise<RuntimeSelection> {
    const root = this.store.root, directory = insideProject(root, mkdtempSync(join(projectDirectory(root, '.mixcat', 'comfy', 'g'), 'v-'))), generationId = basename(directory), base = ['.mixcat', 'comfy', 'g', generationId];
    const data = projectDirectory(root, ...base, 'data'); copyTree(root, insideProject(root, join(root, source.data)), data);
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)); }); });
    return { versionId, generationId, data: relative(root, data), browser: relative(root, projectDirectory(root, ...base, 'browser')), home: relative(root, projectDirectory(root, ...base)), port, graphInitialized: source.graphInitialized, workspace };
  }
  private stateParts(selection: RuntimeSelection, workspace: NativeWorkspace) {
    const root = this.store.root, data = insideProject(root, join(root, selection.data));
    // Outputs and native user databases are part of compatibility, not just the active graph.
    const contents = files(root, data).flatMap(file => {
      const name = relative(data, file), checksum = hash(readFileSync(file));
      // Upstream clears temp on startup. Only verified copies of retained provider artifacts are operational.
      const id = /^temp[\\/]mixcat-([a-f0-9-]{36})\.[a-z0-9]+$/i.exec(name)?.[1], artifact = id ? this.store.knownRuntimeArtifact(id) : undefined;
      if (artifact && name.replaceAll('\\', '/') === `temp/mixcat-${artifact.id}${extname(artifact.relativePath)}` && /^\.mixcat[\\/]comfy[\\/](?:provider-)?artifacts[\\/]/.test(artifact.relativePath) && artifact.sha256 === checksum && hash(readFileSync(insideProject(root, join(root, artifact.relativePath)))) === checksum) return [];
      return [[name, checksum]];
    });
    return { versionId: selection.versionId, workspace: hash(JSON.stringify(workspaceContent(workspace))), browser: hash(JSON.stringify(browserContent(workspace))), ledger: this.store.runtimeStateHash(), files: hash(JSON.stringify(contents)) };
  }
  private root(root: string) { if (ensureProjectDirectory(root) !== this.store.root) throw Error('Comfy 维护属于其他项目。'); }
  async prepareCandidate(root: string, manifest: RuntimeManifest): Promise<RuntimeCandidate> {
    this.root(root); const source = this.selection();
    if (manifest.backend.tag !== 'v' + manifest.backend.version || !/^v\d+\.\d+\.\d+$/.test(manifest.backend.tag)) throw Error('Comfy 更新必须指定正式 tag 和完整 SHA。');
    if (manifest.packages.length && !manifest.packages.some(pkg => pkg.name.replaceAll('_', '-').toLowerCase() === 'comfyui-frontend-package' && pkg.version === manifest.frontendVersion)) throw Error('Comfy 前后端依赖清单不匹配。');
    // Installation failure cannot stop or modify the selected environment.
    await prepareRuntime(root, manifest, this.io, true); const combination = this.pin(manifest);
    const workspace = await this.driver.checkpoint();
    source.workspace = workspace;
    this.store.saveRuntimeRecords({ selection: source, intent: { source, state: 'preparing' } });
    await this.driver.stop();
    try {
      const checkpoint = await this.clone(source, source.versionId, workspace);
      const selection = await this.clone(checkpoint, combination.versionId, workspace);
      await this.driver.start(selection, combination); await this.driver.qualify(selection, combination); await this.driver.stop();
      const sourceParts = this.stateParts(source, workspace), sourceHash = hash(JSON.stringify(sourceParts));
      await this.driver.start({ ...source, workspace }, this.combination(source.versionId));
      const candidate = { selection, source, checkpoint, sourceHash, sourceParts, qualifiedAt: new Date().toISOString() };
      this.store.saveRuntimeRecords({ candidates: [...this.candidates().filter(item => item.selection.versionId !== selection.versionId), candidate], intent: null }); return candidate;
    } catch (error) { await this.recover(source, error); throw error; }
  }
  async activateVersion(root: string, versionId: string): Promise<RuntimeSelection> {
    this.root(root); const candidate = this.candidates().find(item => item.selection.versionId === versionId);
    if (!candidate) throw Error('Comfy 候选尚未通过原生兼容验证。');
    return this.switch(candidate, false);
  }
  async rollbackVersion(root: string, versionId: string): Promise<RuntimeSelection> {
    this.root(root); const checkpoint = this.store.runtimeRecord<RuntimeSelection>('checkpoint:' + versionId);
    if (!checkpoint?.workspace) throw Error('Comfy 缺少兼容的升级前检查点。');
    const selection = await this.clone(checkpoint, versionId, checkpoint.workspace);
    return this.switch({ selection, checkpoint, source: this.selection(), sourceHash: '', qualifiedAt: '' }, true);
  }
  private async switch(candidate: RuntimeCandidate, rollback: boolean) {
    const source = this.selection(), workspace = await this.driver.checkpoint();
    source.workspace = workspace;
    this.store.saveRuntimeRecords({ selection: source, intent: { source, state: 'checkpointing' } });
    await this.driver.stop();
    try {
      const parts = this.stateParts(source, workspace);
      if (!rollback && (candidate.source.versionId !== source.versionId || candidate.sourceHash !== hash(JSON.stringify(parts)))) throw Error('Comfy 项目在验证后已变更，请重新准备候选：' + Object.keys(parts).filter(key => candidate.sourceParts?.[key] !== parts[key as keyof typeof parts]).join(', '));
      const checkpoint = await this.clone(source, source.versionId, workspace), target = candidate.selection;
      this.store.saveRuntimeRecords({ intent: { source, target, state: 'starting' } });
      await this.driver.start(target, this.combination(target.versionId)); await this.driver.qualify(target, this.combination(target.versionId));
      this.store.saveRuntimeRecords({ selection: target, ['checkpoint:' + source.versionId]: checkpoint, intent: null }); return target;
    } catch (error) { await this.recover(source, error); throw error; }
  }
  private async recover(source: RuntimeSelection, cause: unknown) {
    // A failed stop retains ownership; never start a competitor or remove a foreign lock.
    try { await this.driver.stop(); await this.driver.start(source, this.combination(source.versionId)); this.store.saveRuntimeRecords({ intent: null }); }
    catch (recovery) { this.store.saveRuntimeRecords({ intent: { source, state: 'recovery_failed', reason: String(cause), recovery: String(recovery) } }); throw new AggregateError([cause, recovery], 'Comfy 切换失败且旧环境恢复失败；保留全部环境与数据，请重试安全关闭。'); }
  }
}
