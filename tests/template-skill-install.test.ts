import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { installTemplateSkill } from '../src/core/template-skill-install.js';

test('the authored skill installer cannot walk up and replace an ancestor repository installation', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'template-capabilities-193'), 'skill-boundary-'));
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  const project = projectDirectory(root, 'nested-project');
  const bin = projectDirectory(root, 'fixture-bin');
  const marker = join(root, 'installer-ran');
  writeFileSync(join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx'), 'fixture');
  writeFileSync(join(projectDirectory(bin, 'node_modules', 'npm', 'bin'), 'npx-cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected install');`);
  const previous = process.env.PATH; process.env.PATH = bin;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  await assert.rejects(installTemplateSkill(project, true), /上层 Git 仓库/);
  assert.equal(existsSync(marker), false);
});
