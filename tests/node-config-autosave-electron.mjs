import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { CommandDispatcher } from '../src/core/commands.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-config-autosave'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
const options = { workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Configuration edits must not start an Agent'); } };
let engine = new WorkflowEngine(options); await engine.init();
let dispatcher = new CommandDispatcher(engine);
const project = (await engine.command({ type: 'create_project', root: fixture, name: '节点自动保存', goal: '验证节点配置自动保存' })).snapshot.selected.project;
const snapshot = async () => (await engine.command({ type: 'snapshot', projectId: project.id })).snapshot.selected;
for (const node of (await snapshot()).nodes.filter(n => n.id !== 'review')) await engine.command({ type: 'save_node', projectId: project.id, node: { ...node, model: 'model-a' } });
const unsaved = new Map(); let writes = 0, gate, failNext = false, lockedStatus = null;
const catalog = { models: [{ id: 'model-a', name: 'Model A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], skills: [{ name: 'Fixture skill', path: path('SKILL.md') }], plugins: [{ id: 'fixture@local', name: 'Fixture plugin' }], errors: [] };
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body), command = input.command;
      if (input.inspectId) { response.end(JSON.stringify(dispatcher.inspect(input.inspectId))); return; }
      if (input.unsaved) { unsaved.set(input.unsaved.key, input.unsaved.value); response.end('{}'); return; }
      if (command?.type === 'save_node') {
        writes++;
        if (gate) { const current = gate; current.entered = true; await current.promise; }
        if (failNext) { failNext = false; throw Error('Simulated configuration save failure'); }
      }
      const result = command?.type === 'catalog' ? { ...(await engine.command({ type: 'snapshot' })), catalog } : await dispatcher.dispatch(input);
      if (lockedStatus && result.snapshot?.selected) result.snapshot.selected = { ...result.snapshot.selected, tasks: [{ id: 'lock', nodeId: 'plan', status: lockedStatus, instruction: 'Controlled pending task', threadId: null, turnId: null, attempt: 1, input: {}, result: null, error: null, createdAt: '', finishedAt: null }] };
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = path('preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),inspect:inspectId=>ipcRenderer.invoke('command',{inspectId}),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async(key,value)=>ipcRenderer.invoke('command',{unsaved:{key,value}}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(path('main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1550,height:1050,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
function hold() { let release; const promise = new Promise(done => release = done); gate = { promise, release, entered: false }; }
function release() { const current = gate; gate = undefined; current?.release(); }
const delay = ms => new Promise(done => setTimeout(done, ms));
let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc, screenshot } = browser;
  const readNode = async id => (await snapshot()).nodes.find(n => n.id === id);
  const clean = async () => { await poll(() => evaluate("!document.querySelector('.draft-indicator')")); await poll(() => unsaved.get(project.id) === false); };
  const choose = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await poll(() => evaluate("!!document.querySelector('.workspace-sidebar')"));
  await click('nav[aria-label=工作空间] button', '项目'); await click('.sidebar-project-list button', '节点自动保存');
  await click('#tab-config');
  await fill('.node-config textarea[aria-label="职责与指令"]', '自动保存后的职责');
  await poll(async () => (await snapshot()).nodes.find(n => n.id === 'plan').instructions === '自动保存后的职责');
  await poll(() => evaluate("!document.querySelector('.draft-indicator')"));
  assert.equal(await evaluate("[...document.querySelectorAll('.node-config button')].some(b=>b.textContent.includes('保存配置'))"), false);
  await clean();
  hold(); await fill('.node-config textarea', '保存中的第一版'); await poll(() => gate?.entered);
  await fill('.node-config textarea', '保存中的第二版'); await fill('.node-config textarea', '保存中的最终版');
  await engine.command({ type: 'move_node', projectId: project.id, nodeId: 'plan', position: { x: 510, y: 280 } });
  await click('.react-flow__node[data-id=implement] h3'); await fill('.node-config textarea', '另一节点的待保存职责');
  await click('#tab-conversation'); await click('[aria-label="收起节点详情"]'); release();
  await poll(async () => (await readNode('plan')).instructions === '保存中的最终版' && (await readNode('implement')).instructions === '另一节点的待保存职责');
  assert.deepEqual((await readNode('plan')).position, { x: 510, y: 280 }); await clean();
  await click('.react-flow__node[data-id=plan] h3'); await click('#tab-config');
  assert.equal(await evaluate("document.querySelector('.node-config textarea').value"), '保存中的最终版');
  assert(!await evaluate("document.querySelector('.node-config').textContent.includes('载入最新配置')"));
  const originalTools = (await readNode('plan')).tools;
  await fill('.node-config > label > input', '自动保存节点');
  await choose('.node-config select[aria-label="模型"]', 'model-b');
  await choose('.node-config select[aria-label="思考强度"]', 'low');
  await click('.node-config .tool-choice', 'Fixture skill'); await click('.node-config .tool-choice', 'Fixture plugin');
  await click('.node-config input[aria-label="get_project_context"]');
  await poll(async () => { const n = await readNode('plan'); return n.name === '自动保存节点' && n.model === 'model-b' && n.reasoningEffort === 'low' && n.skills?.length === 1 && n.plugins?.length === 1 && n.tools.includes('get_project_context') !== originalTools.includes('get_project_context'); });
  await clean(); const beforeSearch = writes;
  await fill('.node-config input[aria-label="搜索技能"]', 'unmatched'); await delay(150); assert.equal(writes, beforeSearch);
  await fill('.node-config input[aria-label="搜索技能"]', '');
  await fill('.node-config > label > input', ''); await delay(150); assert.equal(writes, beforeSearch);
  assert(await evaluate("document.querySelector('.node-config').textContent.includes('请填写节点名称')"));
  await fill('.node-config > label > input', '自动保存节点'); await clean();
  await click('.react-flow__node[data-id=review] h3'); const beforeModel = writes;
  await fill('.node-config textarea', '待选择模型的职责'); await delay(150); assert.equal(writes, beforeModel);
  assert(await evaluate("document.querySelector('.node-config').textContent.includes('请选择模型')"));
  await choose('.node-config select[aria-label="模型"]', 'model-a');
  await poll(async () => (await readNode('review')).instructions === '待选择模型的职责'); await clean();
  await click('.react-flow__node[data-id=plan] h3'); failNext = true;
  await fill('.node-config textarea', '失败后保留的职责');
  await poll(() => evaluate("document.querySelector('.node-config [role=alert]')?.textContent.includes('自动保存失败')"));
  const failedWrites = writes;
  await click('.sidebar-project-list button', '节点自动保存'); await delay(200); assert.equal(writes, failedWrites, 'Refresh must not spin retries');
  assert.equal(await evaluate("document.querySelector('.node-config textarea').value"), '失败后保留的职责');
  await click('.node-config button', '重试自动保存');
  await poll(async () => (await readNode('plan')).instructions === '失败后保留的职责'); await clean();
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'waiting_review', 'needs_reconciliation']) {
    lockedStatus = status; await click('.sidebar-project-list button', '节点自动保存');
    await poll(() => evaluate("document.querySelector('.node-config').textContent.includes('可继续编辑草稿')"));
    const beforeLock = writes; await fill('.node-config textarea', '锁定草稿 ' + status); await delay(150); assert.equal(writes, beforeLock, status);
    lockedStatus = null; await click('.sidebar-project-list button', '节点自动保存');
    await poll(async () => (await readNode('plan')).instructions === '锁定草稿 ' + status); await clean();
  }
  hold(); await fill('.node-config textarea', '冲突草稿'); await poll(() => gate?.entered);
  const external = await readNode('plan');
  await engine.command({ type: 'save_node', projectId: project.id, node: { ...external, name: '外部更新名称', instructions: '外部更新职责' } });
  release(); await poll(() => evaluate("document.querySelector('.node-config [role=alert]')?.textContent.includes('自动保存失败')"));
  await click('.sidebar-project-list button', '节点自动保存');
  await poll(() => evaluate("document.querySelector('.node-config').textContent.includes('载入最新配置')"));
  assert.equal((await readNode('plan')).instructions, '外部更新职责');
  assert.equal(await evaluate("document.querySelector('.node-config textarea').value"), '冲突草稿');
  await click('.node-config button', '载入最新配置'); await clean();
  assert.equal(await evaluate("document.querySelector('.node-config textarea').value"), '外部更新职责');
  await click('#tab-conversation'); await fill('#task-instruction', '尚未发送的消息');
  await click('#tab-config'); await fill('.node-config textarea', '消息草稿之外的已保存配置');
  await poll(async () => (await readNode('plan')).instructions === '消息草稿之外的已保存配置');
  assert(await evaluate("!!document.querySelector('.draft-indicator')"), 'Message drafts still need protection');
  await click('#tab-conversation'); assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '尚未发送的消息');
  await fill('#task-instruction', ''); await clean();
  const persisted = (await snapshot()).nodes;
  await engine.close(); engine = new WorkflowEngine(options); await engine.init(); dispatcher = new CommandDispatcher(engine);
  assert.deepEqual((await snapshot()).nodes, persisted);
  await rpc('Page.reload'); await poll(() => evaluate("!!document.querySelector('.project-card')"));
  if (await evaluate("document.querySelector('nav[aria-label=工作空间] button').getAttribute('aria-expanded')!=='true'")) await click('nav[aria-label=工作空间] button', '项目');
  await click('.sidebar-project-list button', '节点自动保存'); await click('#tab-config');
  assert.equal(await evaluate("document.querySelector('.node-config textarea').value"), '消息草稿之外的已保存配置');
  await clean(); await evaluate("document.querySelector('.config-actions').scrollIntoView({block:'end'})");
  await screenshot('node-config-autosaved.png');
  console.log(JSON.stringify({ fixture, automaticSave: 'passed', dirtyIndicator: 'passed', raceAndSwitch: 'passed', fieldsAndValidation: 'passed', failureRetry: 'passed', locksAndConflict: 'passed', messageDraftAndRestart: 'passed', writes }));
} finally { release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
