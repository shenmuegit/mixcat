import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'feed'), 'electron-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused' });
await engine.init(); let failDraft = false, hold;
const releases = []; function latch(match) { let release, entered; const arrived = new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('Expected held command did not arrive')), 10000); entered = value => { clearTimeout(timer); done(value); }; }), promise = new Promise(done => release = done); releases.push(release); hold = { match, promise, entered }; return { arrived, release }; }
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', data => body += data); request.on('end', () => { void (async () => {
    try { const envelope = JSON.parse(body); if (failDraft && envelope.command.type === 'save_feed_draft') throw Error('受控保存失败'); const reply = await engine.command(envelope.command); if (hold?.match(envelope.command)) { const gate = hold; hold = null; gate.entered(reply); await gate.promise; } response.end(JSON.stringify(reply)); }
    catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening'); const url = `http://127.0.0.1:${bridge.address().port}`;
writeFileSync(join(fixture, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},subscribeFeed:()=>()=>{},setFeedUnsaved:async()=>{},setUnsaved:async()=>{},chooseDirectory:async()=>null,panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const result=await new Promise((resolve,reject)=>{const request=require('node:http').request(${JSON.stringify(url)},{method:'POST',agent:false},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{try{const value=JSON.parse(data);response.statusCode>=400?reject(Error(value.error)):resolve(value);}catch(error){reject(error);}});});request.on('error',reject);request.end(JSON.stringify(body));});return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1460,height:960,show:false,webPreferences:{preload:${JSON.stringify(join(fixture,'preload.cjs'))},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
try {
  browser = await openRendererFixture(root, fixture); const { click, fill, poll, evaluate, screenshot } = browser;
  await click('.workspace-sidebar nav button', '信息流');
  await click('.feed-workspace button', '保存文本');
  await fill('[aria-label="文本标题"]', '个人资料验收'); await fill('[aria-label="文本内容"]', '**正文验收**\n<script>window.pwned=true</script>\n[危险](javascript:alert(1))');
  await click('.feed-compose button', '保存到信息流');
  await poll(() => evaluate("document.querySelector('.feed-reader h2')?.textContent==='个人资料验收'"));
  assert.equal(await evaluate('window.pwned'), undefined); assert.equal(await evaluate("!!document.querySelector('.feed-reader a[href^=javascript]')"), false);
  await click('.feed-reader button', '收藏');
  await poll(() => evaluate("document.querySelector('.feed-reader').textContent.includes('取消收藏')"));
  await click('.feed-reader button', '标为未读');
  await poll(() => evaluate("document.querySelector('.feed-reader').textContent.includes('标为已读')"));
  await fill('[aria-label="个人备注"]', '我的备注');
  await click('.workspace-sidebar nav button', '项目');
  await click('.projects-page button', '新建项目');
  await fill('input[placeholder="例如：产品文档更新"]', '个人状态切换对照');
  await fill('input[placeholder="选择已有的非 C 盘项目目录"]', fixture);
  assert.equal(await evaluate("document.querySelectorAll('dialog textarea').length"), 0);
  await click('.modal-actions button', '创建项目');
  await poll(() => evaluate("!document.querySelector('dialog[open]')"));
  await click('.workspace-sidebar nav button', '信息流');
  assert.equal(await evaluate("document.querySelector('[aria-label=个人备注]').value"), '我的备注');
  await poll(async () => (await engine.command({ type: 'search_feed_entries', query: { text: '我的备注' } })).feed.entries.items.length === 1);
  const second = (await engine.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: '第二条资料', body: '第二条独立正文', coverage: 'full' }, requestId: 'second' } })).feed.entry;
  await click('.feed-reader button', '返回列表');
  const oldQuery = latch(command => command.type === 'search_feed_entries' && command.query.text === '验收');
  await fill('[aria-label="搜索信息流"]', '验收'); await oldQuery.arrived;
  await fill('[aria-label="搜索信息流"]', '第二条');
  await poll(() => evaluate("document.querySelectorAll('.feed-title').length===1&&document.querySelector('.feed-title').textContent==='第二条资料'"));
  oldQuery.release();
  await poll(() => evaluate("document.querySelectorAll('.feed-title').length===1&&document.querySelector('.feed-title').textContent==='第二条资料'"));
  await fill('[aria-label="搜索信息流"]', '');
  await poll(() => evaluate("document.querySelectorAll('.feed-title').length===2"));
  const oldReader = latch(command => command.type === 'get_feed_entry' && command.entryId !== second.id);
  await click('.feed-title', '个人资料验收'); await oldReader.arrived;
  await click('.feed-title', '第二条资料');
  await poll(() => evaluate("document.querySelector('.feed-reader h2')?.textContent==='第二条资料'"));
  oldReader.release();
  assert.equal(await evaluate("document.querySelector('.feed-reader h2').textContent"), '第二条资料');
  const oldNote = latch(command => command.type === 'update_feed_entry' && command.mutation.operation === 'saveNote');
  await fill('[aria-label="个人备注"]', '较早的备注'); await oldNote.arrived;
  await fill('[aria-label="个人备注"]', '正在编辑的新备注'); oldNote.release();
  await poll(async () => (await engine.command({ type: 'get_feed_entry', entryId: second.id })).feed.entry.note === '正在编辑的新备注');
  assert.equal(await evaluate("document.querySelector('[aria-label=个人备注]').value"), '正在编辑的新备注');
  await browser.rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await poll(() => evaluate("getComputedStyle(document.querySelector('.feed-list')).display==='none'"));
  assert.equal(await evaluate("document.querySelector('.feed-reader time').textContent.includes('T')"), false);
  assert(await evaluate("!!document.querySelector('.feed-reader time').dateTime"));
  await screenshot('reader-narrow.png');
  await click('.feed-reader button', '返回列表');
  await poll(() => evaluate("document.activeElement?.textContent==='第二条资料'"));
  await browser.rpc('Emulation.clearDeviceMetricsOverride');
  await click('.feed-title', '第二条资料');
  await browser.rpc('Page.enable');
  { const deleting = click('.feed-reader button', '删除内容'); await poll(() => browser.rpc('Page.handleJavaScriptDialog', { accept: true }).then(() => true).catch(() => false)); await deleting; }
  await poll(() => evaluate("document.querySelector('.feed-workspace').textContent.includes('撤销删除')"));
  await click('.feed-workspace button', '撤销删除');
  await poll(() => evaluate("document.querySelector('.feed-reader').textContent.includes('删除内容')"));
  { const deleting = click('.feed-reader button', '删除内容'); await poll(() => browser.rpc('Page.handleJavaScriptDialog', { accept: true }).then(() => true).catch(() => false)); await deleting; }
  await poll(async () => !!(await engine.command({ type: 'get_feed_entry', entryId: second.id })).feed.entry.deletedAt);
  await click('.feed-views button', '回收站');
  await poll(() => evaluate("document.querySelectorAll('.feed-title').length===1&&document.querySelector('.feed-title').textContent==='第二条资料'"));
  assert.equal(await evaluate("!!document.querySelector('.feed-reader')"), false);
  await click('.feed-title', '第二条资料');
  await click('.feed-reader button', '恢复内容');
  await poll(async () => !(await engine.command({ type: 'get_feed_entry', entryId: second.id })).feed.entry.deletedAt);
  await poll(() => evaluate("!document.querySelector('.feed-reader')"));
  await screenshot('trash-restored.png');
  await click('.feed-views button', '全部内容');
  await click('.feed-title', '第二条资料');
  await screenshot('reader.png');
  for (let index = 0; index < 30; index++) await engine.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: `滚动资料 ${index}`, body: '足够长的列表用于检查阅读前后的滚动位置。', coverage: 'full' }, requestId: `scroll-${index}` } });
  await fill('[aria-label="搜索信息流"]', '滚动资料');
  await click('.feed-reader button', '返回列表');
  await poll(() => evaluate("document.querySelectorAll('.feed-title').length===30"));
  await click('.feed-title', '滚动资料 15');
  await poll(() => evaluate("document.querySelector('.feed-reader h2')?.textContent==='滚动资料 15'"));
  const scrollBefore = await evaluate("document.querySelector('.feed-list').scrollTop");
  assert(scrollBefore > 0);
  await click('.feed-reader button', '返回列表');
  await poll(() => evaluate("document.activeElement?.textContent==='滚动资料 15'"));
  assert.equal(await evaluate("document.querySelector('.feed-list').scrollTop"), scrollBefore);
  await click('.feed-title', '滚动资料 15');
  await click('.feed-reader button', '返回列表');
  await click('.feed-workspace button', '保存文本');
  failDraft = true; await fill('[aria-label="文本内容"]', '失败仍保留的输入');
  await poll(() => evaluate("document.querySelector('.feed-workspace').textContent.includes('受控保存失败')"));
  assert.equal(await evaluate("document.querySelector('[aria-label=文本内容]').value"), '失败仍保留的输入');
  failDraft = false; await click('.feed-workspace button', '重试保存草稿');
  await poll(async () => (await engine.command({ type: 'read_feed_draft', key: 'manual' })).feed.draft?.text.includes('失败仍保留的输入'));
  const previousDocument = await evaluate('performance.timeOrigin');
  await browser.rpc('Page.reload');
  await poll(async () => {
    try { return await evaluate(`performance.timeOrigin !== ${previousDocument} && document.readyState === 'complete' && !!document.querySelector('.workspace-sidebar nav')`); }
    catch (error) { if (/Execution context|Cannot find context|Inspected target navigated or closed/i.test(String(error))) return false; throw error; }
  });
  await click('.workspace-sidebar nav button', '信息流'); await click('.feed-workspace button', '保存文本');
  await poll(() => evaluate("document.querySelector('[aria-label=文本内容]')?.value==='失败仍保留的输入'"));
  await screenshot('draft-restored.png');
  console.log(JSON.stringify({ passed: true, fixture }));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { for (const release of releases) release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
