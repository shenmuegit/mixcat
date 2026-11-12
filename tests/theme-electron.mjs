import test from 'node:test';
import assert from 'node:assert/strict';
import { openCanvasFixture } from './canvas-electron-fixture.mjs';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

async function key(f, name, code) {
  for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
}

async function hostContrast(f, selectors) {
  return f.evaluate(`(()=>{
    const rgb=value=>value.match(/[\\d.]+/g).slice(0,3).map(Number);
    const luminance=channels=>channels.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return ${JSON.stringify(selectors)}.map(selector=>{
      const e=document.querySelector(selector),s=getComputedStyle(e);let b=e;
      while(b&&getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)')b=b.parentElement;
      const background=getComputedStyle(b||document.documentElement).backgroundColor,c=luminance(rgb(background));
      const contrast=color=>{const a=luminance(rgb(color));return(Math.max(a,c)+.05)/(Math.min(a,c)+.05)};
      return {selector,background,contrast:contrast(s.color),
        ...(e.matches('input,select,textarea,.feed-message-form')&&parseFloat(s.borderTopWidth)>0?{border:s.borderTopColor,borderContrast:contrast(s.borderTopColor)}:{}),
        ...(e.matches('input[placeholder],textarea[placeholder]')?{placeholderContrast:contrast(getComputedStyle(e,'::placeholder').color)}:{})};
    });
  })()`);
}

test('light feed composer shows a visible focus boundary', { timeout: 120000 }, async t => {
  const f = await openFeedFixture(t);
  await createCollection(f, '焦点资料'); await openCollection(f, '焦点资料');
  assert.equal(await f.evaluate('document.documentElement.dataset.theme'), 'light');
  await f.click('.feed-collection>header h2');
  const [before] = await hostContrast(f, ['.feed-message-form']);
  await f.click('.feed-message-form textarea');
  const [focused] = await hostContrast(f, ['.feed-message-form']);
  assert.notEqual(focused.border, before.border, 'focusing the composer changes its visible boundary');
  assert(focused.borderContrast >= 3, JSON.stringify(focused));
});

test('theme choice follows the applied theme after a storage failure and can be saved again', { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  await f.click('.icon-rail [aria-label="设置"]');
  await f.evaluate(`(()=>{window.restoreThemeStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='mixcat.theme')throw new DOMException('Quota exceeded','QuotaExceededError');return window.restoreThemeStorage.call(this,key,value);};})()`);
  await f.click('select[aria-label=主题]'); await key(f, 'End', 35); await key(f, 'Enter', 13);
  await f.poll(() => f.evaluate('!!document.querySelector(".appearance-settings [role=alert]")'));
  assert.equal(await f.evaluate('document.documentElement.dataset.theme'), 'dark');
  await f.click('.icon-rail [aria-label="项目"]'); await f.click('.icon-rail [aria-label="设置"]');
  assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), 'dark');
  await f.evaluate('Storage.prototype.setItem=window.restoreThemeStorage');
  await f.click('select[aria-label=主题]'); await key(f, 'Home', 36); await key(f, 'Enter', 13);
  await f.poll(() => f.evaluate('localStorage.getItem("mixcat.theme")==="light"'));
  await f.click('select[aria-label=主题]'); await key(f, 'End', 35); await key(f, 'Enter', 13);
  await f.poll(() => f.evaluate('localStorage.getItem("mixcat.theme")==="dark"'));
  await f.rpc('Page.reload');
  await f.poll(() => f.evaluate('document.documentElement?.dataset.theme==="dark"'));
  await f.click('.icon-rail [aria-label="设置"]');
  assert.equal(await f.evaluate('document.querySelector("select[aria-label=主题]").value'), 'dark');
  console.log(JSON.stringify({ fixture: f.fixture, storageFailureRecovered: true }));
});

test('rounded workspace corners blend into the frame in both themes and window widths', { timeout: 120000 }, async t => {
  const f = await openCanvasFixture(t);
  for (const theme of ['dark', 'light']) {
    await f.click('.icon-rail [aria-label="设置"]'); await f.click('select[aria-label=主题]');
    await key(f, theme === 'dark' ? 'End' : 'Home', theme === 'dark' ? 35 : 36); await key(f, 'Enter', 13);
    await f.poll(() => f.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`));
    for (const width of [1460, 1100]) {
      await f.rpc('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
      for (const label of ['项目', '信息流', '笔记', '设置']) {
        await f.click(`.icon-rail [aria-label="${label}"]`);
        const corner = await f.evaluate(`(()=>{
          const e=document.querySelector('.app-content'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
          const bg=selector=>getComputedStyle(document.querySelector(selector)).backgroundColor;
          return {frame:bg('.workspace-shell'),outer:bg('.app-shell'),rail:bg('.icon-rail'),left:s.borderTopLeftRadius,right:s.borderTopRightRadius,
            leftClipped:!e.contains(document.elementFromPoint(r.x+1,r.y+1)),rightClipped:!e.contains(document.elementFromPoint(r.right-1,r.y+1)),inside:e.contains(document.elementFromPoint(r.x+13,r.y+13))};
        })()`);
        assert.equal(corner.frame, corner.rail, `${theme}/${width}/${label}: content corner reveals the surrounding frame color`);
        assert.equal(corner.outer, corner.rail, `${theme}/${width}/${label}: sidebar corners reveal the same outer frame`);
        assert.equal(corner.left, '12px'); assert.equal(corner.right, '12px');
        assert(corner.leftClipped && corner.rightClipped && corner.inside, `${theme}/${width}/${label}: rounded clipping stays visible`);
      }
      await f.screenshot(`corners-${theme}-${width}.png`);
    }
  }
  console.log(JSON.stringify({ fixture: f.fixture, cornerVariants: 16 }));
});

test('theme switches by keyboard, keeps readable host surfaces and survives a new Electron process', { timeout: 120000 }, async t => {
  let f = await openCanvasFixture(t);
  const directory = f.fixture;
  try {
    await f.click('.icon-rail [aria-label="设置"]');
    await f.screenshot('theme-before.png');
    assert(await f.evaluate('!!document.querySelector("select[aria-label=主题]")'), 'settings exposes the theme choice');
    await f.click('select[aria-label=主题]');
    await key(f, 'End', 35); await key(f, 'Enter', 13);
    await f.poll(() => f.evaluate('document.documentElement.dataset.theme === "dark"'));
    await f.evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)');
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
    await f.click('select[aria-label=主题]'); await key(f, 'Home', 36); await key(f, 'Enter', 13);
    await f.poll(() => f.evaluate('document.documentElement.dataset.theme === "light"'));
    await f.evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)');
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
