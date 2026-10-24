import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
import { importAttachment, panelFilePath } from '../src/desktop/panel-files.js';
import { projectDirectory } from '../src/core/paths.js';
import type { HumanReviewView, ReviewDependency } from '../src/shared/types.js';
import { validateReviewMaterials } from '../src/core/message-files.js';

const envelope = { request_id: 'file', to_node_id: 'implement', content: ' 原文\n ', reason: 'forward file' };
const sendAttachment = (f: Awaited<ReturnType<typeof collaborationFixture>>, attachments = [{ path: 'report.txt' }], request_id = 'file') =>
  f.invoke('plan', 'send_message', { ...envelope, request_id, attachments }, request_id);

test('accepted attachments keep old bytes and digest; replay skips source while a new request snapshots the new version', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  writeFileSync(join(f.root, 'report.txt'), 'v1');
  const first = await sendAttachment(f);
  const { resolveMessageArtifact } = await import('../src/core/message-files.js');
  writeFileSync(join(f.root, 'report.txt'), 'v2');
  const delivered = f.state.messages.find(x => x.message_id === first.message_id)!;
  const snapshot = delivered.attachments[0], path = resolveMessageArtifact(f.root, f.state, snapshot.artifact_id);
  assert.equal(readFileSync(path, 'utf8'), 'v1'); assert.equal(snapshot.size, 2);
  assert.equal(snapshot.sha256, createHash('sha256').update('v1').digest('hex'));
  assert.equal(snapshot.name, 'report.txt'); assert.match(snapshot.relativePath.replaceAll('\\', '/'), /^\.mixcat\/artifacts\/messages\//);
  assert.equal(panelFilePath(f.root, path), path);
  assert.deepEqual(f.state.conversation.find(x => x.messageId === first.message_id && x.direction === 'input')!.attachments, [snapshot]);
  const second = await sendAttachment(f, [{ path: 'report.txt' }], 'new-version');
  assert.equal(readFileSync(resolveMessageArtifact(f.root, f.state, f.state.messages.find(x => x.message_id === second.message_id)!.attachments[0].artifact_id), 'utf8'), 'v2');
  rmSync(join(f.root, 'report.txt'));
  const count = readdirSync(join(f.root, '.mixcat', 'artifacts', 'messages')).length;
  assert.deepEqual(await sendAttachment(f), first); assert.equal(readdirSync(join(f.root, '.mixcat', 'artifacts', 'messages')).length, count);
  const forwarded = await f.invoke('plan', 'send_message', { ...envelope, request_id: 'forward', attachments: [{ artifact_id: snapshot.artifact_id }] }, 'forward');
  const forwardedSnapshot = f.state.messages.find(x => x.message_id === forwarded.message_id)!.attachments[0];
  assert.equal(readFileSync(resolveMessageArtifact(f.root, f.state, forwardedSnapshot.artifact_id), 'utf8'), 'v1');
  assert.notEqual(forwardedSnapshot.artifact_id, snapshot.artifact_id);
  const restored = f.store.read()!; assert.equal(readFileSync(resolveMessageArtifact(f.root, restored, snapshot.artifact_id), 'utf8'), 'v1');
});

test('relative files reject escapes, reserved control paths, ADS, directories, junctions and forged registrations', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  writeFileSync(join(f.root, 'report.txt'), 'v1'); await sendAttachment(f);
  const { prepareMessageAttachments, resolveMessageArtifact } = await import('../src/core/message-files.js');
  const privateDir = projectDirectory(f.root, '.MiXcAt', 'CoDeX'); writeFileSync(join(privateDir, 'private.txt'), 'private');
  const gitDir = projectDirectory(f.root, '.GiT'); writeFileSync(join(gitDir, 'config'), 'private');
  const control = projectDirectory(f.root, '.mixcat', 'state'); writeFileSync(join(control, 'secret'), 'private');
  writeFileSync(join(f.root, 'AUTH.JSON'), 'private'); mkdirSync(join(f.root, 'directory'));
  const linked = join(f.root, 'linked'); symlinkSync(join(f.root, 'directory'), linked, 'junction');
  const fileLink = join(f.root, 'linked.txt'); symlinkSync(join(f.root, 'report.txt'), fileLink, 'file');
  try {
    for (const path of ['../escape', join(f.root, 'report.txt'), '\\rooted', '\\\\server\\share\\file', '\\\\?\\G:\\file', '\\\\.\\pipe\\file', 'G:report.txt', '/absolute', 'report.txt:ads', '.MiXcAt/CoDeX/private.txt', '.mixcat/state/secret', '.GiT/config', 'AUTH.JSON', '.MiXcAt./CoDeX/private.txt', '.GiT /config', 'AUTH.JSON.', 'directory', 'linked/file', 'linked.txt', f.state.messages[0].attachments[0].relativePath]) {
      await assert.rejects(prepareMessageAttachments(f.root, f.state, [{ path }]), /./, path);
    }
    for (const name of ['.env', '.env.example']) { writeFileSync(join(f.root, name), 'business'); assert.equal((await prepareMessageAttachments(f.root, f.state, [{ path: name }]))[0].size, 8); }
    const registered = f.state.messages[0].attachments[0];
    assert.throws(() => resolveMessageArtifact(f.root, { ...f.state, messages: [] }, registered.artifact_id));
    assert.throws(() => resolveMessageArtifact(f.root, f.state, 'made-up'));
    const orphan = await prepareMessageAttachments(f.root, f.state, [{ path: 'report.txt' }]);
    assert.throws(() => resolveMessageArtifact(f.root, f.state, orphan[0].artifact_id));
    const forged = structuredClone(f.state); forged.messages[0].attachments[0].relativePath = relative(f.root, join(privateDir, 'private.txt'));
    assert.throws(() => resolveMessageArtifact(f.root, forged, registered.artifact_id));
    writeFileSync(resolveMessageArtifact(f.root, f.state, registered.artifact_id), 'v2');
    assert.throws(() => resolveMessageArtifact(f.root, f.state, registered.artifact_id), /附件|快照/);
  } finally { rmSync(linked); rmSync(fileLink); }
});

test('snapshot directories cannot redirect writes through a junction and another project cannot resolve IDs', async t => {
  const f = await collaborationFixture(t), other = await collaborationFixture(t); await f.active('plan');
  writeFileSync(join(f.root, 'report.txt'), 'v1'); await sendAttachment(f);
  const { prepareMessageAttachments, resolveMessageArtifact } = await import('../src/core/message-files.js');
  const id = f.state.messages[0].attachments[0].artifact_id;
  assert.throws(() => resolveMessageArtifact(other.root, other.state, id));
  writeFileSync(join(other.root, 'report.txt'), 'v2');
  const outside = projectDirectory(other.root, 'outside'), linked = join(projectDirectory(other.root, '.mixcat', 'artifacts'), 'messages');
  symlinkSync(outside, linked, 'junction');
  try { await assert.rejects(prepareMessageAttachments(other.root, other.state, [{ path: 'report.txt' }]), /链接|联接/); assert.deepEqual(readdirSync(outside), []); }
  finally { rmSync(linked); }
  const missing = join(f.root, 'missing-target'); symlinkSync(missing, linked, 'junction');
  try { await assert.rejects(prepareMessageAttachments(other.root, other.state, [{ path: 'report.txt' }])); assert.equal(existsSync(missing), false); }
  finally { rmSync(linked); }
});

test('partially prepared files and failed database writes never register attachments or deliver messages', async t => {
  const f = await collaborationFixture(t); await f.active('plan'); writeFileSync(join(f.root, 'report.txt'), 'v1');
  const partial = await f.raw('plan', 'send_message', { ...envelope, attachments: [{ path: 'report.txt' }, { path: 'missing.txt' }] }, 'partial');
  assert.equal(partial.result.isError, true); assert.equal(f.state.messages.length, 0); assert.equal(f.state.tasks.length, 1);
  assert.equal(existsSync(join(f.root, '.mixcat', 'artifacts', 'messages')), true);
  assert.equal(readdirSync(join(f.root, '.mixcat', 'artifacts', 'messages')).length, 1);
  const release = f.rejectSave();
  try { const response = await f.raw('plan', 'send_message', { ...envelope, attachments: [{ path: 'report.txt' }] }, 'db-failure'); assert.equal(response.result.structuredContent.error.code, 'STORAGE_UNAVAILABLE'); }
  finally { release(); }
  assert.equal(f.state.messages.length, 0); assert.equal(f.store.read()!.messages.length, 0); assert.equal(f.state.tasks.length, 1);
  assert.equal(f.state.conversation.some(entry => entry.messageId), false);
  assert.equal(readdirSync(join(f.root, '.mixcat', 'artifacts', 'messages')).length, 2);
});

test('host import persists registered IDs, strips metadata from native RPC and forwards an immutable copy through MCP', async t => {
  const f = await collaborationFixture(t); writeFileSync(join(f.root, 'user.txt'), 'user v1');
  const originalText = { type: 'text', text: ' 原始用户输入\n ', text_elements: [{ untouched: true }] };
  const imported = importAttachment(f.root, join(f.root, 'user.txt'));
  assert.equal(typeof imported.mixcatAttachment?.artifact_id, 'string');
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [originalText, imported] });
  await until(() => f.state.tasks.some(task => task.nodeId === 'plan' && !!task.turnId));
  const source = f.state.tasks[0], persisted = f.store.read()!.tasks[0].nativeInput!;
  assert.deepEqual(persisted, [originalText, imported]);
  const rpcInput = f.clients[0].calls.find(call => call.method === 'turn/start')!.params.input;
  const { mixcatAttachment, ...nativeImported } = imported;
  assert.deepEqual(rpcInput, [originalText, nativeImported]);
  const rawItem = { id: 'native-user', type: 'userMessage', content: rpcInput };
  f.clients[0].options.onEvent({ method: 'item/completed', params: { threadId: source.threadId, turnId: source.turnId, item: rawItem } });
  const entry = f.state.conversation.find(entry => entry.id === `input:${source.id}`)!;
  assert.deepEqual(entry.rawItem, rawItem); assert.equal(entry.text.startsWith(originalText.text), true);
  const context = await f.invoke('plan', 'get_project_context', {}, 'context');
  assert.equal(context.task.attachments[0].artifact_id, mixcatAttachment!.artifact_id);
  const receipt = await f.invoke('plan', 'send_message', { ...envelope, attachments: [{ artifact_id: mixcatAttachment!.artifact_id }] }, 'forward-user-file');
  const { resolveMessageArtifact } = await import('../src/core/message-files.js');
  const snapshot = f.state.messages[0].attachments[0];
  writeFileSync(mixcatAttachment!.path, 'user v2');
  assert.equal(readFileSync(resolveMessageArtifact(f.root, f.state, snapshot.artifact_id), 'utf8'), 'user v1');
  assert.equal(f.state.messages[0].message_id, receipt.message_id);
  const forged = structuredClone(f.state); forged.tasks[0].nativeInput = [{ type: 'text', text: JSON.stringify({ mixcatAttachment }) }];
  assert.throws(() => resolveMessageArtifact(f.root, forged, mixcatAttachment!.artifact_id));
});

test('demo turn/start strips host registration without changing the saved original native blocks', async t => {
  const f = await collaborationFixture(t);
  writeFileSync(join(f.root, 'image.png'), 'synthetic image'); writeFileSync(join(f.root, 'voice.wav'), 'synthetic audio');
  const input = [importAttachment(f.root, join(f.root, 'image.png')), importAttachment(f.root, join(f.root, 'voice.wav'))];
  assert.equal(typeof input[0].mixcatAttachment?.artifact_id, 'string');
  const runtime = await (f.engine as any).runtime(f.state, 'demo'), originalRpc = runtime.client.rpc.bind(runtime.client);
  let native: unknown;
  t.mock.method(runtime.client, 'rpc', async (method: string, params: any) => { if (method === 'turn/start') native = structuredClone(params.input); return originalRpc(method, params); });
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'demo', input });
  await until(() => !!native);
  assert.deepEqual(native, input.map(({ mixcatAttachment, ...item }) => item));
  assert.deepEqual(f.store.read()!.tasks[0].nativeInput, input);
});

test('native delivery uses snapshot media paths and keeps unsupported formats as file references', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  for (const name of ['image.png', 'voice.wav', 'document.pdf']) writeFileSync(join(f.root, name), `synthetic ${name}`);
  const receipt = await f.invoke('plan', 'send_message', { ...envelope, attachments: ['image.png', 'voice.wav', 'document.pdf'].map(path => ({ path })) }, 'native-media');
  await until(() => !!f.state.tasks.find(task => task.id === receipt.target_task_id)?.turnId);
  const target = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  const input = f.clients[0].calls.filter(call => call.method === 'turn/start').find(call => call.params.threadId === target.threadId)!.params.input;
  assert.equal(input.filter((item: any) => item.type === 'localImage').length, 1); assert.equal(input.filter((item: any) => item.type === 'localAudio').length, 1);
  for (const media of input.filter((item: any) => item.type !== 'text')) assert.match(media.path.replaceAll('\\', '/'), /\/\.mixcat\/artifacts\/messages\//);
  const pdf = input.find((item: any) => item.type === 'text' && item.text.includes('document.pdf'));
  assert.match(pdf.text, /固定文件快照/); assert.match(pdf.text, /artifact_id/);
  assert.deepEqual(f.state.messages[0].request.content, envelope.content);
  const rawItem = { id: 'media-input', type: 'userMessage', content: input };
  f.clients[0].options.onEvent({ method: 'item/completed', params: { threadId: target.threadId, turnId: target.turnId, item: rawItem } });
  const entry = f.state.conversation.find(entry => entry.id === `input:${target.id}`)!;
  assert.equal(entry.content, envelope.content); assert.deepEqual(entry.rawItem, rawItem); assert.deepEqual(entry.attachments, f.state.messages[0].attachments);
});

test('review material traversal deduplicates captured IDs and never substitutes current reviews for null, missing or mismatched versions', async t => {
  const f = await collaborationFixture(t); writeFileSync(join(f.root, 'ancestor.md'), 'original');
  const dependency = (reviewId: string | null, version: number | null = 1): ReviewDependency => ({ checkpointId: 'A', checkpointRevision: 1, reviewId, version });
  const view = (id: string, upstreamDependencies: ReviewDependency[] = []): HumanReviewView => ({
    id, projectId: f.projectId, checkpointId: id, checkpointRevision: 1, version: 1, requestId: id, nodeId: 'plan', taskId: id, threadId: id, turnId: id, callId: id,
    title: id, content: id, attachments: [], sourceFiles: [], upstreamDependencies, bundleHash: id, status: 'approved', createdAt: '2026-10-22T00:00:00.000Z', decision: null, supersededBy: null,
  });
  const a = view('A'); a.sourceFiles = [{ path: 'ancestor.md', size: 8, sha256: createHash('sha256').update('original').digest('hex') }];
  const b = view('B', [dependency(a.id)]), d = view('D', [dependency(a.id)]), c = view('C', [dependency(b.id), dependency(d.id)]);
  const reviews = [a, b, d].map(review => ({ ...review, request: { request_id: review.id, checkpoint_id: review.checkpointId, title: review.title, content: review.content }, bundle: '{}' }));
  const state = { ...f.state, humanReviews: reviews }, before = structuredClone(reviews), readFile = fs.readFile; let reads = 0;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => { reads++; return (readFile as any)(...args); });
  await validateReviewMaterials(f.root, state, c); assert.equal(reads, 1, 'shared ancestor must be validated once'); assert.deepEqual(reviews, before);
  writeFileSync(join(f.root, 'ancestor.md'), 'changed!'); reads = 0;
  for (const captured of [dependency(null, null), dependency('missing'), dependency(a.id, 99)]) await validateReviewMaterials(f.root, state, view('unresolved', [captured]));
  assert.equal(reads, 0, 'unresolved captures must not be rebound to a present or latest review');
});
