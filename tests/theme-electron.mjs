import test from 'node:test';
import assert from 'node:assert/strict';
import { openCanvasFixture } from './canvas-electron-fixture.mjs';

async function key(f, name, code) {
  for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
}

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
    const styles = await f.evaluate(`(()=>{
      const rgb = value => value.match(/[\\d.]+/g).slice(0,3).map(Number);
      const luminance = channels => channels.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return ['.settings-page','.workspace-sidebar','.icon-rail','select[aria-label=主题]','.settings-page .button.primary'].map(selector=>{
        const e=document.querySelector(selector),s=getComputedStyle(e);let b=e;
        while(b&&getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)')b=b.parentElement;
        const background=getComputedStyle(b||document.documentElement).backgroundColor;
        const a=luminance(rgb(s.color)),c=luminance(rgb(background));
        return {selector,background,contrast:(Math.max(a,c)+.05)/(Math.min(a,c)+.05)};
      });
    })()`);
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
    assert.equal(await f.evaluate('getComputedStyle(document.documentElement).backgroundColor'), 'rgb(255, 255, 255)');
    console.log(JSON.stringify({ fixture: directory, styles }));
  } catch (error) { console.log(`Theme fixture: ${directory}`); await f.screenshot('theme-failure.png').catch(() => {}); throw error; }
});
