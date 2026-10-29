import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { CommandDispatcher } from '../src/core/commands.js';

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
    const draft = await engine.command({ type: 'save_feed_draft', draft: { key: 'manual', text: '尚未保存' }, expectedRevision: 0, requestId: 'draft' });
    assert.equal(draft.feed!.draft!.revision, 1);
    await assert.rejects(engine.command({ type: 'save_feed_draft', draft: { key: 'manual', text: '旧输入' }, expectedRevision: 0, requestId: 'old' }), /冲突/);
  } finally { await engine.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try { await reopened.init(); const reply = await reopened.command({ type: 'read_feed_draft', key: 'manual' }); assert.equal(reply.feed!.draft!.text, '尚未保存'); assert.equal(reply.feed!.snapshot.generation, 2); }
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

test('valid Unicode note drafts above 256 KiB survive reopening before note autosave', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'unicode-'));
  const note = '备'.repeat(100000); assert(Buffer.byteLength(note, 'utf8') > 256 * 1024);
  const first = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' }); let id: string;
  try {
    await first.init(); const reply = await first.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: '长备注', body: '正文', coverage: 'full' }, requestId: 'long-create' } }); id = reply.feed!.entry!.id;
    await new CommandDispatcher(first).dispatch({ id: 'long-draft', command: { type: 'save_feed_draft', draft: { key: `note:${id}`, text: note }, expectedRevision: 0, requestId: 'long-draft' } });
  } finally { await first.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture' });
  try {
    await reopened.init(); const draft = await reopened.command({ type: 'read_feed_draft', key: `note:${id!}` }); assert.equal(draft.feed!.draft!.text, note);
    const saved = await reopened.command({ type: 'update_feed_entry', mutation: { operation: 'saveNote', id: id!, expectedRevision: 1, note: draft.feed!.draft!.text, requestId: 'long-note' } }); assert.equal(saved.feed!.entry!.note, note);
    await assert.rejects(reopened.command({ type: 'save_feed_draft', draft: { key: 'oversize', text: '备'.repeat(350000) }, expectedRevision: 0, requestId: 'oversize' }), /1 MiB/);
  } finally { await reopened.close(); }
});

test('collection list query is paginated, compact and scopes deleted cursors', async t => {
 const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed'), 'collection-list-'));
 const engine = new WorkflowEngine({workbenchRoot:root,executable:'fixture',accountFactory:()=>({async connect(){},async close(){},async rpc(){return {account:null} as any;}}),nativeFactory:()=>({async connect(){},async close(){},async rpc(){return {} as any;}})});
 t.after(()=>engine.close()); await engine.init(); const dispatch=new CommandDispatcher(engine);
 const ids: string[]=[];
 for(let index=0;index<4;index++){ const result=await dispatch.dispatch({id:`collection-${index}`,command:{type:'create_feed_collection',name:`Task ${index}`,instruction:'long instruction '.repeat(100),input:{text:'Start'},requestId:`list-create-${index}`}});ids.push(result.feed!.admission!.collectionId); }
 const result=await dispatch.dispatch({id:'page-one',command:{type:'list_feed_collections',limit:2}}),page=result.feed!.collectionPage!;
 assert.equal(page.items.length,2);assert(page.nextCursor);assert(!('instruction' in page.items[0]));assert(!('inputSnapshot' in (page.items[0].latestRun??{})));
 const next=await dispatch.dispatch({id:'page-two',command:{type:'list_feed_collections',limit:2,cursor:page.nextCursor!}});assert.equal(next.feed!.collectionPage!.items.length,2);assert.equal(new Set([...page.items,...next.feed!.collectionPage!.items].map(item=>item.id)).size,4);
 await assert.rejects(dispatch.dispatch({id:'wrong-scope',command:{type:'list_feed_collections',deleted:true,cursor:page.nextCursor!}}),/游标/);
 await assert.rejects(dispatch.dispatch({id:'extra',command:{type:'list_feed_collections',projectId:'forged'} as never}),/Unrecognized|unrecognized/);
});
