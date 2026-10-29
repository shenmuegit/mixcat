import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = ensureProjectDirectory(resolve('.'));
const evidence = projectDirectory(root, '.runtime', 'implementation', 'shared-editor-isolation');
const fixture = ensureProjectDirectory(mkdtempSync(insideProject(root, join(evidence, 'electron-'))));
const entry = insideProject(fixture, join(fixture, 'app.tsx'));
writeFileSync(entry, `import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentEditorPane } from ${JSON.stringify(join(root, 'src/renderer/DocumentEditorPane.tsx'))};
function App() {
  const [identity,setIdentity]=useState('note:a'),[drafts,setDrafts]=useState({'note:a':'笔记正文','project:p:a':'项目正文'});
  const pending=useRef(null);
  return <><button onClick={()=>setIdentity('note:a')}>打开笔记</button><button onClick={()=>setIdentity('project:p:a')}>打开项目</button><button onClick={()=>pending.current?.(['assets/note.png'])}>完成图片</button>
    <DocumentEditorPane identity={identity} title={identity} content={drafts[identity]} editing onTitleChange={()=>{}} onContentChange={content=>setDrafts(current=>({...current,[identity]:content}))} onPasteImage={()=>new Promise(resolve=>{pending.current=resolve})}/>
    <output data-note>{drafts['note:a']}</output><output data-project>{drafts['project:p:a']}</output></>;
}
createRoot(document.getElementById('root')).render(<App/>);`);
await build({ entryPoints: [entry], bundle: true, format: 'iife', jsx: 'automatic', outfile: join(fixture, 'app.js'), loader: { '.css': 'css' } });
writeFileSync(join(fixture, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>');
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>new BrowserWindow({width:1100,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(fixture, 'index.html'))}));`);
let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc } = browser;
  await poll(() => evaluate("!!document.querySelector('[aria-label=工作项正文]')"));
  await fill('[aria-label=工作项正文]', '笔记草稿');
  await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([1])],'note.png',{type:'image/png'}));document.querySelector('[aria-label=工作项正文]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await click('button', '打开项目');
  await poll(() => evaluate("document.querySelector('.shared-document').dataset.contentIdentity==='project:p:a'"));
  await click('button', '完成图片');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("document.querySelector('[data-project]').textContent"), '项目正文', 'a delayed note upload cannot insert into a project with the same local ID');
  await fill('[aria-label=工作项正文]', '项目草稿');
  await click('button', '打开笔记');
  await evaluate("document.querySelector('[aria-label=工作项正文]').focus()");
  for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2 });
  assert.equal(await evaluate("document.querySelector('[data-note]').textContent"), '笔记草稿', 'switching sources isolates undo history');
  assert.equal(await evaluate("document.querySelector('[data-project]').textContent"), '项目草稿');
  await browser.screenshot('isolated-source-drafts.png');
  console.log(JSON.stringify({ passed: true, fixture }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); }
