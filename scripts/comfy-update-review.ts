import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.js';
import type { RuntimeManifest } from '../src/core/comfy-runtime.js';

// Review is deliberately separate from runtime startup and activation.
const [project, target, tag, sha] = process.argv.slice(2);
if (!project || !target || !tag || !sha) throw Error('Usage: comfy-update-review.ts PROJECT TARGET_MANIFEST EXACT_TAG EXACT_SHA');
const root = ensureProjectDirectory(resolve(project));
const manifest = JSON.parse(readFileSync(insideProject(root, resolve(target)), 'utf8')) as RuntimeManifest;
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha) || manifest.backend.tag !== tag || manifest.backend.commit !== sha || tag !== 'v' + manifest.backend.version) throw Error('Target must identify one explicit official release tag and full SHA.');
if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(manifest.id)) throw Error('Invalid target runtime ID.');
const lock = manifest.packages.map(pkg => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`).join('\n') + '\n';
if (createHash('sha256').update(lock).digest('hex') !== manifest.lockSha256) throw Error('Complete dependency lock hash mismatch.');
if (!manifest.packages.some(pkg => pkg.name.replaceAll('_', '-').toLowerCase() === 'comfyui-frontend-package' && pkg.version === manifest.frontendVersion)) throw Error('Pinned frontend package does not match target frontend.');
const current = JSON.parse(readFileSync(join(root, 'resources/comfy/runtime-manifest.json'), 'utf8')) as RuntimeManifest;
const normalize = (name: string) => name.toLowerCase().replaceAll('_', '-');
const old = new Map(current.packages.map(pkg => [normalize(pkg.name), pkg]));
const differences = manifest.packages.flatMap(pkg => { const before = old.get(normalize(pkg.name)); old.delete(normalize(pkg.name)); return JSON.stringify(before) === JSON.stringify(pkg) ? [] : [{ name: pkg.name, before, after: pkg }]; });
const directory = projectDirectory(root, '.runtime', 'comfy-update-review', manifest.id);
writeFileSync(insideProject(root, join(directory, 'runtime-manifest.json')), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(insideProject(root, join(directory, 'requirements.lock')), lock);
writeFileSync(insideProject(root, join(directory, 'review.json')), JSON.stringify({ backend: { before: current.backend, after: manifest.backend }, python: { before: current.python, after: manifest.python }, frontend: { before: current.frontendVersion, after: manifest.frontendVersion }, differences, removed: [...old.values()], checklist: ['Review official release notes, exact backend tag/SHA and matching frontend package.', 'Verify every package hash and the complete transitive dependency lock.', 'Prepare the independent candidate through ComfyHost.prepareCandidate; retain the compatible native data/browser checkpoint.', 'Prove real native page/bridge/nodes, every open tab/draft/subgraph, fake Ark/MiniMax/Vidu, VIDEO and retained-run recovery.', 'Activate only while idle and after source-bound compatibility succeeds; rehearse rollback and retain newer data.', 'Submit the reviewed recommendation/lock/extension change as its own PR; startup never follows master/nightly.'] }, null, 2));
console.log(directory);
