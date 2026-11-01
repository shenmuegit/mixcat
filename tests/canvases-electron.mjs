import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCanvasFixture } from './canvas-electron-fixture.mjs';

async function key(f, name, modifiers = 0, vk) { for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, modifiers, windowsVirtualKeyCode: vk }); }
async function point(f, x, y) { for (const type of ['mousePressed', 'mouseReleased']) await f.rpc('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
async function drag(f, x, y, endX, endY, button = 'left') {
  await f.rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  for (let step = 1; step <= 5; step++) await f.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (endX - x) * step / 5, y: y + (endY - y) * step / 5, button, buttons: button === 'middle' ? 4 : 1 });
  await f.rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button, clickCount: 1 });
}
const selected = f => f.evaluate("localStorage.getItem('mixcat.canvas.selected')");
const scene = async f => f.store.command({ operation: 'read', id: await selected(f) }).canvas.scene;

test('official canvas renders at website dimensions and supports drawing, text, history and local exports', async t => {
  const f = await openCanvasFixture(t);
  try {
    await f.click('.icon-rail button', '画布'); await f.click('[aria-label="新建画布"]');
    await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .App-toolbar")'));
    const bounds = await f.evaluate('document.querySelector(".canvas-workspace").getBoundingClientRect().toJSON()');
    await f.rpc('Emulation.setDeviceMetricsOverride', { width: 1442 + bounds.x, height: 1007 + bounds.y, deviceScaleFactor: 1.5, mobile: false });
    await f.click('.excalidraw button[aria-label="矩形"]');
    await f.evaluate('document.fonts.ready.then(()=>true)');
    const metrics = await f.evaluate(`(()=>{const root=document.querySelector('.canvas-workspace'),rr=root.getBoundingClientRect();const rect=s=>{const e=root.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return{x:r.x-rr.x,y:r.y-rr.y,width:r.width,height:r.height,radius:c.borderRadius,font:c.fontFamily}};return{viewport:[rr.width,rr.height],toolbar:rect('.App-toolbar'),properties:rect('.App-menu__left'),slider:rect('.range-input'),font:getComputedStyle(root.querySelector('.excalidraw')).fontSize}})()`);
    assert.deepEqual(metrics.viewport, [1442, 1007]);
    assert.deepEqual([metrics.toolbar.x, metrics.toolbar.y, metrics.toolbar.width, metrics.toolbar.height, metrics.toolbar.radius], [450, 16, 542, 44, '8px']);
    assert.deepEqual([metrics.properties.x, metrics.properties.y, metrics.properties.width], [16, 76, 195]);
    // shortcut: offscreen CJK line boxes round differently; confirm exact panel height in the visible desktop.
    assert(Math.abs(metrics.properties.height - 545.6667) < 3, JSON.stringify(metrics)); assert.equal(metrics.slider.height, 4); assert.equal(metrics.font, '16px');
    assert(metrics.toolbar.font.startsWith('Assistant'));
    await f.screenshot('01-official-properties.png');
    const x = bounds.x + 350, y = bounds.y + 200;
    await drag(f, x, y, x + 180, y + 120);
    await f.poll(async () => (await scene(f)).elements.some(e => e.type === 'rectangle'), 300);
    await f.click('.excalidraw button[aria-label="文字"]'); await point(f, x + 20, y + 200);
    await f.rpc('Input.insertText', { text: 'Mixcat 独立画布' }); await key(f, 'Escape', 0, 27);
    await f.poll(async () => (await scene(f)).elements.some(e => e.type === 'text' && e.text === 'Mixcat 独立画布'), 300);
    await f.click('.excalidraw button[aria-label="撤销"]');
    await f.poll(async () => !(await scene(f)).elements.some(e => e.type === 'text' && !e.isDeleted), 300);
    await f.click('.excalidraw button[aria-label="重做"]');
    await f.poll(async () => (await scene(f)).elements.some(e => e.type === 'text' && !e.isDeleted), 300);
    await f.click('.excalidraw .App-menu_top__left button'); await f.click('.excalidraw [role=menuitem]', '保存到');
    await f.click('.excalidraw button[aria-label="保存为文件"]');
    const exported = extension => existsSync(join(f.fixture, 'exports')) && readdirSync(join(f.fixture, 'exports')).find(name => name.endsWith(extension) && existsSync(join(f.fixture, 'exports', name + '.done')));
    await f.poll(() => exported('.excalidraw'));
    const file = JSON.parse(readFileSync(join(f.fixture, 'exports', exported('.excalidraw')), 'utf8'));
    assert.equal(file.type, 'excalidraw'); assert(file.elements.some(e => e.text === 'Mixcat 独立画布'));
    await f.click('.excalidraw .App-menu_top__left button'); await f.click('.excalidraw [role=menuitem]', '导出图片');
    await f.evaluate("Promise.all(document.querySelector('.excalidraw .Modal').getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))).then(()=>true)");
    const dialogStyles = await f.evaluate("(()=>{const e=document.querySelector('.excalidraw .Modal .Switch'),r=e.getBoundingClientRect(),c=getComputedStyle(e),input=document.querySelector('.excalidraw .Modal .RadioGroup__choice input');return{width:r.width,height:r.height,duration:c.transitionDuration,radioBackground:getComputedStyle(input).backgroundColor}})()");
    assert.deepEqual(dialogStyles, { width: 40, height: 20, duration: '0.15s', radioBackground: 'rgba(0, 0, 0, 0)' });
    await f.click('.excalidraw button[aria-label="导出为 PNG"]'); await f.poll(() => exported('.png'));
    assert.equal(readFileSync(join(f.fixture, 'exports', exported('.png'))).subarray(1, 4).toString(), 'PNG');
    await f.click('.excalidraw button[aria-label="导出为 SVG"]'); await f.poll(() => exported('.svg'));
    assert.match(readFileSync(join(f.fixture, 'exports', exported('.svg')), 'utf8'), /<svg/);
    await f.screenshot('02-native-image-export.png');
    await f.click('.excalidraw .Modal input[type="text"]');
    await key(f, 'Escape', 0, 27);
    await f.poll(() => f.evaluate('!document.querySelector(".excalidraw .Modal")'));
    const firstId = await selected(f); await f.click('[aria-label="新建画布"]');
    await f.poll(async () => (await selected(f)) !== firstId);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await f.rpc('Input.dispatchDragEvent', { type, x, y, data: { items: [], files: [join(f.fixture, 'exports', exported('.excalidraw'))], dragOperationsMask: 1 } });
    await f.poll(async () => (await scene(f)).elements.some(e => !e.isDeleted && e.text === 'Mixcat 独立画布'), 300);
    await f.screenshot('03-reimported-excalidraw.png');
    writeFileSync(join(f.fixture, 'acceptance.json'), JSON.stringify({ metrics, formats: readdirSync(join(f.fixture, 'exports')).filter(name => !name.endsWith('.done')) }, null, 2));
    console.log(JSON.stringify({ test: t.name, fixture: f.fixture }));
  } catch (error) { console.log(`Canvas failure fixture: ${f.fixture}`); await f.screenshot('failure.png').catch(() => {}); throw error; }
});

test('canvas notes, images, library, viewport and theme survive switching and a new Electron process', { timeout: 120000 }, async t => {
  let f = await openCanvasFixture(t);
  try {
    await f.click('.icon-rail button', '画布'); await f.click('[aria-label="新建画布"]');
    await f.click('.excalidraw button[aria-label="矩形"]');
    const root = await f.evaluate('document.querySelector(".canvas-workspace").getBoundingClientRect().toJSON()');
    const x = root.x + 350, y = root.y + 180;
    await drag(f, x, y, x + 160, y + 100);
    await f.click('.excalidraw button[aria-label="素材库"]');
    await f.poll(() => f.evaluate('!!document.querySelector(".library-unit__active:not(.library-unit--skeleton)")'), 300);
    await f.click('.excalidraw .library-unit__active');
    await f.poll(() => f.store.command({ operation: 'get_library' }).library.items.length === 1, 300);
    await f.click('.excalidraw .sidebar__close');
    await f.click('.excalidraw button[aria-label="Sticky note"]'); await point(f, x, y + 220);
    await f.rpc('Input.insertText', { text: '便签内容' }); await key(f, 'Escape', 0, 27);
    await f.poll(async () => (await scene(f)).elements.some(e => e.type === 'stickynote'), 300);
    const png = await f.evaluate("(()=>{const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.fillStyle='#1971c2';x.fillRect(0,0,16,16);return c.toDataURL('image/png').split(',')[1]})()");
    const imagePath = join(f.fixture, 'blue.png'); writeFileSync(imagePath, Buffer.from(png, 'base64'));
    for (const type of ['dragEnter', 'dragOver', 'drop']) await f.rpc('Input.dispatchDragEvent', { type, x: x + 240, y: y + 260, data: { items: [], files: [imagePath], dragOperationsMask: 1 } });
    await f.poll(async () => (await scene(f)).elements.some(e => e.type === 'image' && e.status === 'saved'), 300);
    assert.equal(Object.keys((await scene(f)).files).length, 1);
    await f.click('.excalidraw button[aria-label="放大"]');
    await drag(f, x + 10, y + 400, x + 90, y + 450, 'middle');
    await f.poll(async () => { const s = await scene(f); return s.appState.zoom.value > 1 && s.appState.scrollX !== 0; }, 300);
    const viewport = (await scene(f)).appState;
    await f.click('.excalidraw .App-menu_top__left button'); await f.click('.excalidraw .RadioGroup__choice[title^="深色模式"]');
    await key(f, 'Escape', 0, 27);
    await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw.theme--dark")'));
    const firstId = await selected(f);
    await f.click('[aria-label="管理画布：未命名画布"]'); await f.click('.canvas-actions button', '重命名');
    await f.fill('dialog[aria-label="重命名画布"] input', '素材画板'); await f.click('dialog[aria-label="重命名画布"] button', '保存');
    await f.click('[aria-label="新建画布"]');
    await f.poll(async () => (await selected(f)) !== firstId);
    const secondId = await selected(f); assert.equal((await scene(f)).elements.length, 0);
    await f.click('.canvas-item-open', '素材画板'); await f.poll(async () => (await selected(f)) === firstId);
    await f.poll(() => !f.dirty(), 300);
    assert.equal((await scene(f)).appState.zoom.value, viewport.zoom.value);
    await f.screenshot('03-library-image-and-note.png');
    const fixture = f.fixture; await f.close();
    f = await openCanvasFixture(t, fixture); await f.click('.icon-rail button', '画布');
    await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .App-toolbar")'));
    await f.poll(() => !f.dirty(), 300);
    const restored = await scene(f);
    assert(restored.elements.some(e => e.type === 'image' && !e.isDeleted));
    assert(restored.elements.some(e => e.text === '便签内容' && !e.isDeleted));
    assert.equal(Object.keys(restored.files).length, 1);
    assert.equal(restored.appState.zoom.value, viewport.zoom.value);
    assert.equal(restored.appState.scrollX, viewport.scrollX);
    assert.equal(restored.appState.scrollY, viewport.scrollY);
    assert.equal(restored.appState.viewModeEnabled, false);
    assert.equal(f.store.command({ operation: 'get_library' }).library.items.length, 1);
    assert(await f.evaluate('!!document.querySelector(".excalidraw.theme--dark")'));
    await f.click('[aria-label="管理画布：未命名画布"]'); await f.click('.canvas-actions button', '删除');
    await f.click('dialog[aria-label="删除画布"] .danger-button');
    await f.poll(() => f.store.command({ operation: 'list' }).canvases.length === 1);
    assert.throws(() => f.store.command({ operation: 'read', id: secondId }), /不存在/);
    await f.screenshot('04-restored-canvas.png');
    console.log(JSON.stringify({ test: t.name, fixture: f.fixture }));
  } catch (error) { console.log(`Canvas failure fixture: ${f.fixture}`); await f.screenshot('failure.png').catch(() => {}); throw error; }
});

test('canvas retries uncertain writes and drains edits made during a held save before navigation', { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  try {
    await f.click('.icon-rail button', '画布'); await f.click('[aria-label="新建画布"]');
    await f.click('.excalidraw button[aria-label="矩形"]');
    const firstId = await selected(f);
    await f.poll(() => f.store.command({ operation: 'read', id: firstId }).canvas.revision >= 2 && !f.dirty(), 300);
    const bounds = await f.evaluate('document.querySelector(".canvas-workspace").getBoundingClientRect().toJSON()');
    const x = bounds.x + 350, y = bounds.y + 180;
    f.rejectCommittedSave(); await drag(f, x, y, x + 100, y + 80);
    await f.poll(() => f.evaluate('document.querySelector(".canvas-notice")?.textContent.includes("保存确认丢失")'), 300);
    assert.equal(f.dirty(), true);
    const revision = f.store.command({ operation: 'read', id: firstId }).canvas.revision;
    await f.click('.canvas-notice button'); await f.poll(() => !f.dirty(), 300);
    assert.equal(f.store.command({ operation: 'read', id: firstId }).canvas.revision, revision);
    const gate = f.holdSave();
    await f.click('.excalidraw button[aria-label="矩形"]'); await drag(f, x + 150, y, x + 250, y + 80);
    await gate.arrived;
    await f.click('.excalidraw button[aria-label="矩形"]'); await drag(f, x + 300, y, x + 400, y + 80);
    await f.click('[aria-label="新建画布"]'); assert.equal(await selected(f), firstId);
    gate.release();
    await f.poll(async () => (await selected(f)) !== firstId, 300);
    const saved = f.store.command({ operation: 'read', id: firstId }).canvas;
    assert.equal(saved.scene.elements.filter(e => e.type === 'rectangle' && !e.isDeleted).length, 3);
    assert.equal((await scene(f)).elements.length, 0);
    await f.screenshot('05-race-recovery.png');
    await f.click('.canvas-list-item:has(.canvas-item-open[aria-current="page"]) .canvas-item-menu');
    await f.click('.canvas-actions button', '删除'); await f.click('dialog[aria-label="删除画布"] .danger-button');
    await f.poll(() => !f.dirty() && f.store.command({ operation: 'list' }).canvases.length === 1, 300);
    assert.equal(await selected(f), null);
    console.log(JSON.stringify({ test: t.name, fixture: f.fixture }));
  } catch (error) { console.log(`Canvas failure fixture: ${f.fixture}`); await f.screenshot('failure.png').catch(() => {}); throw error; }
});
