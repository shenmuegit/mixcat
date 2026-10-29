import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { launchFeedProductionFixture } from './feed-production-ipc-fixture.mjs';

const root = resolve('.');
if (process.argv[2] === '--failure-child') {
  const fixture = insideProject(root, process.argv[3]), mode = process.argv[4];
  let original;
  if (mode === 'readiness') {
    original = Error('deliberate fixture readiness failure');
    await assert.rejects(() => launchFeedProductionFixture(root, fixture, 1, async evaluate => {
      assert.equal(await evaluate('false'), false); throw original;
    }), error => error === original);
  } else {
    const browser = await launchFeedProductionFixture(root, fixture, 1);
    try {
      // Quit outside close(), so its required NEW shutdown-complete evidence deliberately fails.
      await browser.rpc('Browser.close').catch(error => { if (!String(error).includes('CDP timeout')) throw error; });
      await browser.poll(() => { try { process.kill(browser.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'external fixture exit');
      await assert.rejects(() => browser.close(), error => { original = error; return /core shutdown: complete/.test(String(error)); });
    } catch (error) { await browser.cleanupFailure(error); throw error; }
  }
  const evidence = JSON.parse(readFileSync(join(fixture, 'failure-cleanup-1.json'), 'utf8'));
  assert.equal(evidence.error, String(original));
  assert.equal(evidence.childExited, true); assert.equal(evidence.socketClosed, true); assert.equal(evidence.pipesDestroyed, true); assert.equal(evidence.pendingRequests, 0);
  assert.equal(existsSync(join(fixture, 'shutdown-1.json')), false, 'Failure cleanup must not create normal shutdown evidence');
  assert.throws(() => process.kill(evidence.pid, 0), { code: 'ESRCH' });
  await assert.rejects(() => fetch(`http://127.0.0.1:${evidence.port}/json/version`, { signal: AbortSignal.timeout(1000) }));
  console.log(JSON.stringify({ passed: true, mode, fixture, pid: evidence.pid, port: evidence.port }));
} else {
  for (const mode of ['readiness', 'shutdown']) test(`${mode} failure closes the isolated fixture and its runner exits`, async () => {
    const fixture = insideProject(root, mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'feed'), `cleanup-${mode}-`)));
    cpSync(join(root, 'dist/client'), insideProject(fixture, join(fixture, 'dist/client')), { recursive: true });
    const runner = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--failure-child', fixture, mode], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    runner.stdout.on('data', data => output += data); runner.stderr.on('data', data => output += data);
    const timer = setTimeout(() => {
      timedOut = true;
      // Bound a future cleanup regression without orphaning that test runner's fixture descendants.
      if (runner.exitCode === null && runner.signalCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        else runner.kill('SIGKILL');
      }
    }, 45000);
    let exit;
    try { exit = await once(runner, 'close', { signal: AbortSignal.timeout(55000) }); }
    finally { clearTimeout(timer); runner.stdout.destroy(); runner.stderr.destroy(); runner.unref(); writeFileSync(join(fixture, 'runner.log'), output); }
    assert.equal(timedOut, false, `Runner hung after failure: ${output}`); assert.equal(exit[0], 0, output);
    assert.match(output, /"passed":true/); console.log(output.trim());
  });
}
