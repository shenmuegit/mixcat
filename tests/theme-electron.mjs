import test from 'node:test';
import assert from 'node:assert/strict';
import { openCanvasFixture } from './canvas-electron-fixture.mjs';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

async function key(f, name, code) {
  for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
}

async function chooseTheme(f, theme) {
  await f.click('select[aria-label=主题]');
  const index = await f.evaluate(`[...document.querySelector('select[aria-label=主题]').options].findIndex(option=>option.value===${JSON.stringify(theme)})`);
  assert(index >= 0, `${theme} is available in the theme picker`);
  await key(f, 'Home', 36);
  for (let step = 0; step < index; step++) await key(f, 'ArrowDown', 40);
  await key(f, 'Enter', 13);
  await f.poll(() => f.evaluate(`document.documentElement?.dataset.theme===${JSON.stringify(theme)}`));
  await f.evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)');
}

test('violet theme is selected by keyboard and remembered by a new Electron process', { timeout: 120000 }, async t => {
  let f = await openCanvasFixture(t);
  const directory = f.fixture;
  try {
    await f.click('.icon-rail [aria-label="设置"]');
    await f.evaluate('localStorage.setItem("mixcat.canvas.theme","light")');
    await chooseTheme(f, 'violet');
    assert.equal(await f.evaluate('localStorage.getItem("mixcat.theme")'), 'violet');
    await f.close(); f = await openCanvasFixture(t, directory);
    await f.poll(() => f.evaluate('document.documentElement?.dataset.theme==="violet"'));
    await f.click('.icon-rail [aria-label="设置"]');
    assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), 'violet');
    assert.equal(await f.evaluate('localStorage.getItem("mixcat.canvas.theme")'), 'light');
    for (const style of await hostContrast(f, ['.window-titlebar','.settings-page','.workspace-sidebar','.icon-rail','select[aria-label=主题]','.settings-page .button.primary'])) assert(style.contrast >= 4.5, JSON.stringify(style));
    await f.screenshot('theme-violet-settings.png');
    await f.click('.icon-rail [aria-label="画布"]'); await f.click('[aria-label="新建画布"]');
    await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .App-toolbar")'));
    assert.equal(await f.evaluate('!!document.querySelector(".excalidraw.theme--dark")'), true, 'canvas follows the violet app theme despite a legacy light preference');
    assert.equal(await f.evaluate('getComputedStyle(document.querySelector(".excalidraw")).fontSize'), '16px');
    await f.click('.excalidraw .App-menu_top__left button');
    assert.equal(await f.evaluate('!!document.querySelector(".excalidraw .RadioGroup__choice[title^=深色模式]")'), false, 'appearance is controlled by the app settings');
    await key(f, 'Escape', 27);
    await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw.theme--dark")'));
    assert.equal(await f.evaluate('document.documentElement.dataset.theme'), 'violet');
    assert.equal(await f.evaluate('localStorage.getItem("mixcat.theme")'), 'violet');
  } finally { await f.close(); }
});

test('mounted canvas follows all app themes without changing artwork or viewport', { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  const created = f.store.command({ operation: 'create', requestId: 'theme-canvas', name: '主题画布' }).canvas;
  f.store.command({ operation: 'save', id: created.id, requestId: 'theme-content', expectedRevision: created.revision, scene: {
    elements: [{ id: 'theme-rectangle', type: 'rectangle', x: 120, y: 100, width: 180, height: 100, strokeColor: '#1971c2', backgroundColor: '#a5d8ff' }],
    appState: { viewBackgroundColor: '#fff4e6', scrollX: 70, scrollY: -20, zoom: { value: 1.25 } }, files: {},
  } });
  await f.evaluate('localStorage.setItem("mixcat.canvas.theme","system")');
  await f.click('.icon-rail [aria-label="画布"]');
  await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .App-toolbar")'));
  const content = () => {
    const { elements, appState, files } = f.store.command({ operation: 'read', id: created.id }).canvas.scene;
    return { elements, files, background: appState.viewBackgroundColor, scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom };
  };
  const variants = [];
  for (const width of [1460, 1100]) {
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
    for (const [theme, expected, menuExpected] of [['light', 'rgb(255, 255, 255)', 'rgb(250, 250, 250)'], ['dark', 'rgb(25, 25, 27)', 'rgb(20, 20, 21)'], ['violet', 'rgb(33, 27, 70)', 'rgb(33, 27, 70)']]) {
      await f.click('.icon-rail [aria-label="设置"]'); await f.poll(() => !f.dirty(), 300);
      const before = content();
      await chooseTheme(f, theme); await f.click('.icon-rail [aria-label="画布"]');
      await f.poll(() => f.evaluate(`document.querySelector('.excalidraw')?.classList.contains('theme--dark')===${theme !== 'light'}`));
      const selectors = ['.excalidraw .App-toolbar'];
      if (width === 1460) {
        await f.click('.excalidraw button[aria-label="选择"]'); await f.click('.excalidraw button[aria-label="矩形"]');
        await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .App-menu__left")'));
        selectors.push('.excalidraw .App-menu__left');
      }
      const surfaces = await hostContrast(f, selectors);
      for (const style of surfaces) { assert.equal(style.background, expected); assert(style.contrast >= 4.5, JSON.stringify(style)); }
      assert(surfaces[0].mutedContrast >= 4.5, JSON.stringify(surfaces[0]));
      assert(surfaces[0].focusContrast >= 3, JSON.stringify(surfaces[0]));
      if (width === 1460) { const [slider] = await hostContrast(f, ['.excalidraw .range-input']); assert(slider.thumbContrast >= 3, JSON.stringify(slider)); }
      await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .reset-zoom-button")'));
      const [footer] = await hostContrast(f, ['.excalidraw .reset-zoom-button']); assert(footer.contrast >= 4.5, JSON.stringify(footer));
      await f.click('.excalidraw .App-menu_top__left button');
      assert.equal(await f.evaluate('!!document.querySelector(".excalidraw .RadioGroup__choice[title^=深色模式]")'), false);
      const [menu] = await hostContrast(f, ['.excalidraw [role=menu]']);
      assert.equal(menu.background, menuExpected); assert(menu.contrast >= 4.5, JSON.stringify(menu));
      let modal;
      if (width === 1460) {
        await f.click('.excalidraw [role=menuitem]', '导出图片');
        await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .Modal__content")'));
        [modal] = await hostContrast(f, ['.excalidraw .Modal__content']);
        assert.equal(modal.background, expected); assert(modal.contrast >= 4.5, JSON.stringify(modal));
        await f.click('.excalidraw .Modal input[type="text"]');
      }
      await key(f, 'Escape', 27);
      await f.click('.excalidraw button[aria-label="素材库"]');
      await f.poll(() => f.evaluate('!!document.querySelector(".excalidraw .sidebar")'));
      const [library] = await hostContrast(f, ['.excalidraw .sidebar']);
      assert.equal(library.background, expected); assert(library.contrast >= 4.5, JSON.stringify(library));
      const [hint] = await hostContrast(f, ['.excalidraw .library-menu-items__no-items__hint']); assert(hint.contrast >= 4.5, JSON.stringify(hint));
      await f.screenshot(`canvas-theme-${theme}-${width}.png`);
      await f.click('.excalidraw .sidebar__close');
      await f.click('.icon-rail [aria-label="设置"]'); await f.poll(() => !f.dirty(), 300);
      assert.deepEqual(content(), before, `${theme}/${width}: host appearance must preserve the scene and viewport`);
      variants.push({ theme, width, surfaces, menu, library, hint, footer, modal });
    }
  }
  console.log(JSON.stringify({ fixture: f.fixture, canvasThemeVariants: variants }));
});

async function hostContrast(f, selectors) {
  return f.evaluate(`(()=>{
    const normalized=document.createElement('span').style;
    const rgb=value=>{normalized.color=value;return normalized.color.match(/[\\d.]+/g).slice(0,3).map(Number)};
    const luminance=channels=>channels.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return ${JSON.stringify(selectors)}.map(selector=>{
      const e=document.querySelector(selector);if(!e)throw Error('Missing contrast target: '+selector);const s=getComputedStyle(e);let b=e;
      while(b&&getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)')b=b.parentElement;
      const background=getComputedStyle(b||document.documentElement).backgroundColor,c=luminance(rgb(background));
      const contrast=color=>{const a=luminance(rgb(color));return(Math.max(a,c)+.05)/(Math.min(a,c)+.05)};
      return {selector,background,contrast:contrast(s.color),
        ...(e.matches('.App-toolbar')?{mutedContrast:contrast(s.getPropertyValue('--color-gray-50')),focusContrast:contrast(s.getPropertyValue('--color-primary-darkest'))}:{}),
        ...(e.matches('.range-input')?{thumbContrast:contrast(s.getPropertyValue('--color-slider-thumb'))}:{}),
        ...(e.matches('input,select,textarea,.feed-message-form')&&parseFloat(s.borderTopWidth)>0?{border:s.borderTopColor,borderContrast:contrast(s.borderTopColor)}:{}),
        ...(e.matches('input[placeholder],textarea[placeholder]')?{placeholderContrast:contrast(getComputedStyle(e,'::placeholder').color)}:{})};
    });
  })()`);
}

for (const theme of ['light', 'violet']) test(`${theme} feed composer shows a visible focus boundary`, { timeout: 120000 }, async t => {
  const f = await openFeedFixture(t);
  if (theme === 'violet') { await f.click('.icon-rail [aria-label="设置"]'); await chooseTheme(f, theme); await f.click('.icon-rail [aria-label="信息流"]'); }
  await createCollection(f, '焦点资料'); await openCollection(f, '焦点资料');
  assert.equal(await f.evaluate('document.documentElement.dataset.theme'), theme);
  await f.click('.feed-collection>header h2');
  const [before] = await hostContrast(f, ['.feed-message-form']);
  await f.click('.feed-message-form textarea');
  const [focused] = await hostContrast(f, ['.feed-message-form']);
  assert.notEqual(focused.border, before.border, 'focusing the composer changes its visible boundary');
  assert(focused.borderContrast >= 3, JSON.stringify(focused));
});

for (const theme of ['dark', 'violet']) test(`${theme} choice follows the applied theme after a storage failure and can be saved again`, { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  await f.click('.icon-rail [aria-label="设置"]');
  await f.evaluate(`(()=>{window.restoreThemeStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='mixcat.theme')throw new DOMException('Quota exceeded','QuotaExceededError');return window.restoreThemeStorage.call(this,key,value);};})()`);
  await chooseTheme(f, theme);
  await f.poll(() => f.evaluate('!!document.querySelector(".appearance-settings [role=alert]")'));
  assert.equal(await f.evaluate('document.documentElement.dataset.theme'), theme);
  await f.click('.icon-rail [aria-label="项目"]'); await f.click('.icon-rail [aria-label="设置"]');
  assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), theme);
  await f.evaluate('Storage.prototype.setItem=window.restoreThemeStorage');
  await chooseTheme(f, 'light');
  await f.poll(() => f.evaluate('localStorage.getItem("mixcat.theme")==="light"'));
  await chooseTheme(f, theme);
  await f.poll(() => f.evaluate(`localStorage.getItem("mixcat.theme")===${JSON.stringify(theme)}`));
  await f.rpc('Page.reload');
  await f.poll(() => f.evaluate(`document.documentElement?.dataset.theme===${JSON.stringify(theme)}`));
  await f.click('.icon-rail [aria-label="设置"]');
  assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), theme);
  console.log(JSON.stringify({ fixture: f.fixture, storageFailureRecovered: true }));
});

test('workspace sidebar is distinct from the icon rail in all host themes and widths', { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  for (const theme of ['dark', 'light', 'violet']) {
    await f.click('.icon-rail [aria-label="设置"]'); await chooseTheme(f, theme);
    for (const width of [1460, 1100]) {
      await f.rpc('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      for (const label of ['项目', '信息流', '笔记', '画布', '知识库', '设置']) {
        await f.click(`.icon-rail [aria-label="${label}"]`);
        const corner = await f.evaluate(`(()=>{
          const e=document.querySelector('.app-content'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
          const bg=selector=>getComputedStyle(document.querySelector(selector)).backgroundColor;
          const navigation=['.window-titlebar','.workspace-shell','.app-shell','.icon-rail'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return {selector,background:style.backgroundColor,image:style.backgroundImage}});
          const sidebar=document.querySelector('.workspace-sidebar'),ss=getComputedStyle(sidebar),sr=sidebar.getBoundingClientRect();
          return {navigation,frame:bg('.workspace-shell'),outer:bg('.app-shell'),rail:bg('.icon-rail'),sidebar:ss.backgroundColor,sidebarImage:ss.backgroundImage,
            sidebarLeft:ss.borderTopLeftRadius,sidebarRight:ss.borderTopRightRadius,sidebarClipped:!sidebar.contains(document.elementFromPoint(sr.x+1,sr.y+1)),left:s.borderTopLeftRadius,right:s.borderTopRightRadius,
            leftClipped:!e.contains(document.elementFromPoint(r.x+1,r.y+1)),rightClipped:!e.contains(document.elementFromPoint(r.right-1,r.y+1)),inside:e.contains(document.elementFromPoint(r.x+13,r.y+13))};
        })()`);
        assert.equal(corner.frame, corner.rail, `${theme}/${width}/${label}: content corner reveals the surrounding frame color`);
        assert.equal(corner.outer, corner.rail, `${theme}/${width}/${label}: sidebar corners reveal the same outer frame`);
        assert.notEqual(corner.sidebar, corner.rail, `${theme}/${width}/${label}: list sidebar is a separate surface from the icon rail`);
        const channels = color => color.match(/\d+/g).slice(0, 3).map(Number);
        const rail = channels(corner.rail), sidebar = channels(corner.sidebar);
        assert(Math.max(...sidebar.map((value, index) => Math.abs(value - rail[index]))) >= 8, `${theme}/${width}/${label}: surface difference is visible`);
        assert.equal(corner.sidebarImage, 'none');
        assert.equal(corner.sidebarLeft, '12px'); assert.equal(corner.sidebarRight, '12px'); assert(corner.sidebarClipped);
        for (const surface of corner.navigation) {
          assert.equal(surface.background, corner.rail, `${theme}/${width}/${label}/${surface.selector}: navigation has one continuous background`);
          assert.equal(surface.image, 'none', `${theme}/${width}/${label}/${surface.selector}: navigation has no separate bright band or wash`);
        }
        assert.equal(corner.left, '12px'); assert.equal(corner.right, '12px');
        assert(corner.leftClipped && corner.rightClipped && corner.inside, `${theme}/${width}/${label}: rounded clipping stays visible`);
        for (const style of await hostContrast(f, ['.workspace-sidebar', '.icon-rail'])) assert(style.contrast >= 4.5, JSON.stringify(style));
      }
      await f.screenshot(`corners-${theme}-${width}.png`);
    }
  }
  console.log(JSON.stringify({ fixture: f.fixture, sidebarVariants: 36 }));
});

test('theme switches by keyboard, keeps readable host surfaces and survives a new Electron process', { timeout: 120000 }, async t => {
  let f = await openCanvasFixture(t);
  const directory = f.fixture;
  try {
    await f.click('.icon-rail [aria-label="设置"]');
    await f.screenshot('theme-before.png');
    assert(await f.evaluate('!!document.querySelector("select[aria-label=主题]")'), 'settings exposes the theme choice');
    await chooseTheme(f, 'dark');
    const styles = await hostContrast(f, ['.settings-page','.workspace-sidebar','.icon-rail','select[aria-label=主题]','.settings-page .button.primary']);
    for (const style of styles) assert(style.contrast >= 4.5, JSON.stringify(style));
    await f.screenshot('theme-dark-settings.png');
    await f.click('.icon-rail button', '项目'); await f.click('.page-heading button', '新建项目');
    assert(await f.evaluate('getComputedStyle(document.querySelector("dialog")).backgroundColor !== "rgb(255, 255, 255)"'));
    await f.screenshot('theme-dark-dialog.png');
    await f.click('dialog [aria-label="关闭弹窗"]');
    await f.close();
    f = await openCanvasFixture(t, directory);
    await f.poll(() => f.evaluate('document.documentElement.dataset.theme === "dark"'));
    await f.click('.icon-rail [aria-label="设置"]');
    assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), 'dark');
    await chooseTheme(f, 'light');
    assert(await f.evaluate('getComputedStyle(document.documentElement).backgroundColor.match(/\\d+/g).slice(0,3).every(channel=>Number(channel)>=240)'), 'light theme uses a bright surface');
    const lightStyles = await hostContrast(f, ['.settings-page','.workspace-sidebar','.icon-rail','select[aria-label=主题]','.settings-page .button.primary']);
    await f.click('.icon-rail button', '项目'); await f.click('.page-heading button', '新建项目');
    lightStyles.push(...await hostContrast(f, ['dialog input[placeholder]']));
    for (const style of lightStyles) {
      assert(style.contrast >= 4.5, JSON.stringify(style));
      if (style.borderContrast !== undefined) assert(style.borderContrast >= 3, JSON.stringify(style));
      if (style.placeholderContrast !== undefined) assert(style.placeholderContrast >= 4.5, JSON.stringify(style));
    }
    await f.screenshot('theme-light-dialog.png');
    await f.click('dialog [aria-label="关闭弹窗"]');
    console.log(JSON.stringify({ fixture: directory, styles, lightStyles }));
  } catch (error) { console.log(`Theme fixture: ${directory}`); await f.screenshot('theme-failure.png').catch(() => {}); throw error; }
});
