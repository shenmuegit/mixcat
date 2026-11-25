import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { CommandDispatcher } from '../src/core/commands.js';

process.env.MIXCAT_HOST_CODEX_HOME ??= resolve('.runtime', 'tests', 'host-account-empty');

test('personal text commands work with zero projects, publish independently and survive reopening', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'commands-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try {
    await engine.init(); const dispatcher = new CommandDispatcher(engine);
    const updates: unknown[] = []; engine.subscribeFeed(value => updates.push(value));
    const initial = await engine.command({ type: 'feed_snapshot' });
    assert.equal(initial.feed!.snapshot.generation, 1);
    const saved = await dispatcher.dispatch({ id: 'save', command: { type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: '个人资料', body: 'Markdown **文本**', coverage: 'full' }, requestId: 'text' } } });
    assert.equal(saved.snapshot.projects.length, 0);
    const entries = await engine.command({ type: 'search_feed_entries', query: {} });
    assert.equal(entries.feed!.entries!.items[0].title, '个人资料');
    assert.equal(entries.feed!.snapshot.unreadCount, 1); assert.equal(updates.length, 1);
  } finally { await engine.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try { await reopened.init(); const reply = await reopened.command({ type: 'search_feed_entries', query: {} }); assert.equal(reply.feed!.entries!.items[0].title, '个人资料'); assert.equal(reply.feed!.snapshot.generation, 2); }
  finally { await reopened.close(); }
});

test('personal storage ownership errors remain local while the project command channel stays usable', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'ownership-'));
  const first = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' }), second = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try {
    await first.init(); await second.init();
    const personal = await second.command({ type: 'feed_snapshot' });
    assert.match(personal.feed!.snapshot.storageError!, /其他工作台/);
    await assert.rejects(second.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: '资料', body: '文本', coverage: 'full' }, requestId: 'unavailable' } }), /其他工作台/);
    const project = await second.command({ type: 'create_project', root: projectDirectory(root, 'project'), name: '现有项目入口', goal: '项目仍然可用' });
    assert.equal(project.snapshot.selected!.project.name, '现有项目入口');
  } finally { await second.close(); await first.close(); }
});

test('personal commands reject unrelated project fields at their public command boundary', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'validation-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try { await engine.init(); await assert.rejects(engine.command({ type: 'feed_snapshot', projectId: 'forged-project' } as never), /Unrecognized|unrecognized/); }
  finally { await engine.close(); }
});

test('only an explicitly saved note survives reopening and the old draft commands are unavailable', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'unicode-'));
  const note = '备'.repeat(100000); assert(Buffer.byteLength(note, 'utf8') > 256 * 1024);
  const first = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' }); let id: string;
  try {
    await first.init(); const reply = await first.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: '长备注', body: '正文', coverage: 'full' }, requestId: 'long-create' } }); id = reply.feed!.entry!.id;
    const dispatch = new CommandDispatcher(first);
    await assert.rejects(dispatch.dispatch({ id: 'legacy-save', command: { type: 'save_feed_draft', draft: { key: `note:${id}`, text: '未完成的备注' }, expectedRevision: 0, requestId: 'legacy' } } as never));
    const saved = await dispatch.dispatch({ id: 'long-save', command: { type: 'update_feed_entry', mutation: { operation: 'saveNote', id, expectedRevision: 1, note, requestId: 'long-note' } } });
    assert.equal(saved.feed!.entry!.note, note);
  } finally { await first.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try {
    await reopened.init();
    await assert.rejects(new CommandDispatcher(reopened).dispatch({ id: 'legacy-read', command: { type: 'read_feed_draft', key: `note:${id!}` } } as never));
    assert.equal((await reopened.command({ type: 'get_feed_entry', entryId: id! })).feed!.entry!.note, note);
  } finally { await reopened.close(); }
});

test('collection list query is paginated and compact with no deleted view or restore command', async t => {
 const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'collection-list-'));
 const engine = new WorkflowEngine({workbenchRoot:root,executable:'fixture',accountFactory:()=>({async connect(){},async close(){},async rpc(){return {account:null} as any;}}),nativeFactory:()=>({async connect(){},async close(){},async rpc(){return {} as any;}})});
 t.after(()=>engine.close()); await engine.init(); const dispatch=new CommandDispatcher(engine);
 const ids: string[]=[];
 for(let index=0;index<4;index++){ const result=await dispatch.dispatch({id:`collection-${index}`,command:{type:'create_feed_collection',name:`Task ${index}`,instruction:'long instruction '.repeat(100),input:{text:'Start'},requestId:`list-create-${index}`}});ids.push(result.feed!.admission!.collectionId); }
 const result=await dispatch.dispatch({id:'page-one',command:{type:'list_feed_collections',limit:2}}),page=result.feed!.collectionPage!;
 assert.equal(page.items.length,2);assert(page.nextCursor);assert.equal(page.items[0].instruction, 'long instruction '.repeat(100));assert(!('inputSnapshot' in (page.items[0].latestRun??{})));
 const next=await dispatch.dispatch({id:'page-two',command:{type:'list_feed_collections',limit:2,cursor:page.nextCursor!}});assert.equal(next.feed!.collectionPage!.items.length,2);assert.equal(new Set([...page.items,...next.feed!.collectionPage!.items].map(item=>item.id)).size,4);
 await assert.rejects(dispatch.dispatch({id:'deleted-view',command:{type:'list_feed_collections',deleted:true,cursor:page.nextCursor!}} as never),/Unrecognized|unrecognized/);
 await assert.rejects(dispatch.dispatch({ id: 'legacy-restore', command: { type: 'restore_feed_collection', collectionId: ids[0], requestId: 'restore', expectedRevision: 1 } } as never));
 await assert.rejects(dispatch.dispatch({id:'extra',command:{type:'list_feed_collections',projectId:'forged'} as never}),/Unrecognized|unrecognized/);
});
