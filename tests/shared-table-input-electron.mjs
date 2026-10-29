import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = ensureProjectDirectory(resolve('.'));
const evidence = projectDirectory(root, '.runtime', 'implementation', 'shared-table-input');
const fixture = ensureProjectDirectory(mkdtempSync(insideProject(root, join(evidence, 'electron-'))));
const bodies = {
  navigation: 'before\n\n| Column |\n| --- |\n| Value |\n\nafter',
  composition: '| 名称 |\r\n| --- |\r\n| **原文** |\r\n|  |',
  limit: '| 列 |\r\n| --- |\r\n| **原文** |',
};
const entry = insideProject(fixture, join(fixture, 'app.tsx'));
writeFileSync(entry, `import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentEditorPane } from ${JSON.stringify(join(root, 'src/renderer/DocumentEditorPane.tsx'))};
import ${JSON.stringify(join(root, 'src/renderer/SharedDocument.css'))};
const bodies=${JSON.stringify(bodies)};
function App(){
  const [scenario,setScenario]=useState('navigation'),[body,setBody]=useState(bodies.navigation),[identity,setIdentity]=useState(0),[editing,setEditing]=useState(true);
  const load=name=>{setScenario(name);setBody(bodies[name]);setIdentity(value=>value+1);setEditing(true)};
  return <><nav>{Object.keys(bodies).map(name=><button key={name} onClick={()=>load(name)}>{name}</button>)}<button onClick={()=>setEditing(value=>!value)}>{editing?'阅读':'编辑'}</button></nav>
    <DocumentEditorPane identity={scenario+':'+identity} title={scenario} content={body} editing={editing} maxLength={scenario==='limit'?bodies.limit.length:131072} onTitleChange={()=>{}} onContentChange={setBody}/>
    <output id="draft" hidden>{body}</output></>;
}
createRoot(document.getElementById('root')).render(<App/>);`);
await build({ entryPoints: [entry], bundle: true, format: 'iife', jsx: 'automatic', outfile: join(fixture, 'app.js'), loader: { '.css': 'css' } });
writeFileSync(join(fixture, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>');
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>new BrowserWindow({width:1100,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(fixture, 'index.html'))}));`);

let browser;
const results = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { click, evaluate, poll, rpc } = browser;
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); };
  const settled = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const draft = () => evaluate("document.getElementById('draft').textContent");
  const cell = () => evaluate("document.querySelector('.document-editing td[contenteditable=true]')?.textContent");
  async function run(name, fn) {
    if (process.env.TABLE_CASE && process.env.TABLE_CASE !== name) return;
    await click('nav button', name); await poll(() => evaluate("!!document.querySelector('.document-editing td[contenteditable=true]')"));
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error.message ?? error) }); await browser.screenshot(`${name}-failure.png`); }
  }
  await run('navigation', async () => {
    await click('.document-preview-block p', 'before'); await key('End'); await rpc('Input.insertText', { text: ' inserted' });
    for (let index = 0; index < 4; index++) { if (await evaluate("document.activeElement?.tagName==='TH'")) break; await key('ArrowDown'); }
    assert.equal(await evaluate("document.activeElement?.tagName"), 'TH', 'ArrowDown enters the header after text inserted before the table shifts its position');
    await click('.document-preview-block p', 'before'); await key('Home'); await key('End', 'End', 1); await rpc('Input.insertText', { text: 'x' });
    for (let index = 0; index < 4; index++) { if (await evaluate("document.activeElement?.tagName==='TH'")) break; await key('ArrowDown'); }
    assert.equal(await evaluate("document.activeElement?.tagName"), 'TH', 'ArrowDown still enters after deleting text before the table');
    await click('.document-preview-block p', 'after'); await key('Home');
    for (let index = 0; index < 4; index++) { if (await evaluate("document.activeElement?.tagName==='TD'")) break; await key('ArrowUp'); }
    assert.equal(await evaluate("document.activeElement?.tagName"), 'TD', 'ArrowUp enters the final cell of the shifted table');
  });
  await run('composition', async () => {
    await click('.document-editing td[contenteditable=true]'); await key('a', 'KeyA', 2);
    await rpc('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await settled();
    assert.equal(await draft(), bodies.composition, 'uncommitted Chinese input leaves the authoritative draft unchanged');
    await rpc('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await settled();
    await rpc('Input.insertText', { text: '中文' }); await settled();
    assert.equal(await draft(), '| 名称 |\r\n| --- |\r\n| **中文** |\r\n|  |', 'committing table IME updates the original Markdown once and retains inline syntax and CRLF');
    await click('.document-editing tr:last-child td[contenteditable=true]');
    await rpc('Input.imeSetComposition', { text: '空白', selectionStart: 2, selectionEnd: 2 }); await settled();
    await rpc('Input.insertText', { text: '空白' }); await settled();
    assert.equal(await draft(), '| 名称 |\r\n| --- |\r\n| **中文** |\r\n|  空白|', 'native IME also commits when an initially empty cell creates DOM text nodes');
    await click('nav button', '阅读');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.document-reading .markdown-mode-body:not([hidden]) td')].map(cell=>cell.textContent)"), ['中文', '空白'], 'reading shows both committed cells from the source');
  });
  await run('limit', async () => {
    await click('.document-editing td[contenteditable=true]'); await key('End'); await rpc('Input.insertText', { text: '超长' }); await settled();
    assert.equal(await draft(), bodies.limit, 'table edits obey the same serialized source length limit');
    assert.equal(await cell(), '原文', 'a rejected table edit cannot leave visible ghost text that was not saved');
    assert.equal(await evaluate("document.querySelector('.document-editing td[contenteditable=true] strong')?.textContent"), '原文', 'rejecting input retains the rendered inline formatting');
    await rpc('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 }); await settled();
    await rpc('Input.insertText', { text: '中' }); await settled();
    assert.equal(await draft(), bodies.limit); assert.equal(await cell(), '原文', 'over-limit IME commits restore the accepted cell');
    await evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain','粘贴超长');document.querySelector('.document-editing td[contenteditable=true]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`); await settled();
    assert.equal(await draft(), bodies.limit); assert.equal(await cell(), '原文', 'over-limit clipboard paste restores the accepted cell');
    await key('a', 'KeyA', 2); await rpc('Input.insertText', { text: '值' }); await settled();
    assert.equal(await draft(), '| 列 |\r\n| --- |\r\n| **值** |', 'a valid shorter edit remains possible after rejection');
  });
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ fixture, results }, null, 2));
  console.log(JSON.stringify({ fixture, results }, null, 2));
  assert(results.length > 0 && results.every(result => result.passed), 'all selected table input scenarios pass');
} finally { await browser?.close(); }
