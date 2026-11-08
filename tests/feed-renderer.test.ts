import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedWorkspace } from '../src/renderer/FeedWorkspace.js';
import { FeedNewCollection } from '../src/renderer/FeedCollectionList.js';
import { FeedCollection, FeedMessage, FeedResult } from '../src/renderer/FeedCollection.js';
import { orderedConversation } from '../src/shared/conversation-order.js';
import type { FeedCollectionDetail, FeedConversationEntry, FeedEntry, FeedRun } from '../src/shared/feed.js';

test('conversation hides routine startup diagnostics and identifies scheduled input without inventing a user sender', () => {
  const item = { id: 'input:run', runId: 'run', source: 'user', text: '执行目标', completed: true, createdAt: '2026-10-29T01:00:00Z' } as FeedConversationEntry;
  for (const [trigger, label] of [['schedule', '定时执行'], ['catchup', '补跑'], ['message', '你']] as const) {
    const html = renderToStaticMarkup(createElement(FeedMessage, { item, run: { trigger } as FeedRun })); assert(html.includes(label));
    if (trigger !== 'message') assert(!html.includes('你'));
  }
  assert(renderToStaticMarkup(createElement(FeedMessage, { item })).includes('会话输入'));
  for (const type of ['sessionConfiguration', 'runtimeCapabilities']) assert.equal(renderToStaticMarkup(createElement(FeedMessage, { item: { ...item, source: 'system', rawItem: { type } } })), '');
  const rejection = { ...item, id: 'goal:run', source: 'system', text: '目标版本冲突，请修正目标。' } as FeedConversationEntry;
  assert(renderToStaticMarkup(createElement(FeedMessage, { item: rejection })).includes(rejection.text));
});

test('feed home invites a collection conversation without the old library controls', () => {
  const html = renderToStaticMarkup(createElement(FeedWorkspace, { snapshot: null, execute: async () => { throw Error('unused'); }, onError() {} }));
  assert(html.includes('从一个采集开始'));
  for (const old of ['保存文本', '搜索信息流', '回收站', '继续调研', '个人资料']) assert(!html.includes(old), old);
});

test('assistant prose reads continuously without per-message sender and timestamp labels', () => {
  const item = { id: 'reply', source: 'assistant', text: '已完成 **资料整理**。', completed: true, createdAt: '2026-11-08T01:00:00Z', rawItem: { type: 'agentMessage' } } as FeedConversationEntry;
  const html = renderToStaticMarkup(createElement(FeedMessage, { item }));
  assert(html.includes('<strong>资料整理</strong>'));
  assert(!html.includes('feed-message-meta'), 'ordinary prose still repeats sender/time metadata');
  assert(!html.includes('Codex ·'));
});

test('tool summaries identify native operations and keep failure and refusal visible', () => {
  const entry = { id: 'tool', source: 'system', completed: true, createdAt: '2026-11-08T01:00:00Z', text: '完整工具输出' } as FeedConversationEntry;
  for (const [rawItem,label] of [
    [{type:'commandExecution',command:'node verify.mjs',status:'completed',exitCode:7},'失败 · 运行命令 node verify.mjs'],
    [{type:'mcpToolCall',server:'github',tool:'get_pull_request',status:'completed'},'已完成 · 使用 github 集成 get_pull_request'],
    [{type:'fileChange',changes:[{path:'src/layout.tsx'}],status:'declined'},'已拒绝 · 编辑文件 src/layout.tsx'],
    [{type:'webSearch',action:{type:'search',query:'公开文档'}},'已完成 · 搜索 公开文档']
  ] as const) {
    const html = renderToStaticMarkup(createElement(FeedMessage, {item:{...entry,rawItem}}));
    assert(html.includes(label),label); assert(html.includes(entry.text)); assert(!html.includes('工具活动'));
  }
});

test('new collection exposes an explicit name and directory plus the composer model picker', () => {
  const drafts={text:()=>'',loaded:()=>true,load:async()=>{},edit(){},update(){},save:async()=>{}};
  const html=renderToStaticMarkup(createElement(FeedNewCollection,{drafts,execute:async()=>{throw Error('unused');},disabled:false,onBack(){},onAccepted(){},navigation:()=>0,onError(){}}));
  for(const name of ['采集名称','工作目录','选择模型与思考强度'])assert(html.includes(name),name);
});
test('persisted result renders the full safe Markdown body', () => {
  const entry = { id: 'entry', title: '完整执行结果', body: '<script>window.pwned=true</script>\n\n[bad](javascript:alert(1))\n\n**安全文本**\n\n' + '正文'.repeat(500) + '\n\n末尾内容', aiSummary: '不替代正文的摘要' } as FeedEntry;
  const html = renderToStaticMarkup(createElement(FeedResult, { entry, collectedAt: '2026-10-29T01:00:00Z' }));
  assert(!html.includes('<script>')); assert(!html.includes('href="javascript:')); assert(html.includes('<strong>安全文本</strong>')); assert(html.includes('末尾内容')); assert(!html.includes(entry.aiSummary!));
});
test('personal conversation ordering preserves readonly personal entries and unknown timestamps', () => {
  const entries = [{ id: 'unknown', seq: 1, createdAt: '', collectionId: 'a' }, { id: 'known', seq: 2, createdAt: '2026-10-29', collectionId: 'a' }] as const;
  assert.deepEqual(orderedConversation(entries).map(entry => entry.id), ['known', 'unknown']); assert.equal(entries[0].id, 'unknown');
});
test('detail exposes accepted plan and native recovery alongside results and conversation', () => {
  const detail = { collection: { id: 'a', name: '新闻采集', instruction: '已接受的每日新闻目标', revision: 2, schedule: { frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', enabled: true }, nextDueAt: '2026-10-30T01:00:00Z', queueHeld: true }, queuedCount: 0, attention: [], activeRun: { id: 'run', status: 'needs_reconciliation' }, runtime: null, requests: [{ key: 'request', request: { id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'read' } } }] } as unknown as FeedCollectionDetail;
  const html = renderToStaticMarkup(createElement(FeedCollection, { detail, execute: async () => { throw Error('unused'); }, onBack() {}, onError() {} }));
  for (const text of ['已接受的每日新闻目标', '每日', '09:00', '下次', '与 Codex 对话', '队列待继续', '核对原生执行', '继续队列', 'Codex 请求批准']) assert(html.includes(text), text);
  for (const old of ['保存回答', '运行记录', '立即采集', '编辑采集说明', '运行安排', '能力设置']) assert(!html.includes(old), old);
});

test('feed detail has one Codex transcript and an accessible composer without redundant visible controls', () => {
  const detail = { collection: { id: 'a', name: '新闻采集', instruction: '', schedule: { frequency: 'manual' }, threadId: 'native-thread' }, queuedCount: 0, attention: [], activeRun: null, runtime: null, requests: [] } as unknown as FeedCollectionDetail;
  const html = renderToStaticMarkup(createElement(FeedCollection, { detail, execute: async () => { throw Error('unused'); }, onBack() {}, onError() {} }));
  assert(!html.includes('feed-detail-columns'), 'details still split results and chat into columns');
  assert(!html.includes('feed-composer-link'));
  assert(!html.includes('同步原生历史'));
  assert(!html.includes('<label>继续沟通目标'));
  assert(html.includes('aria-label="继续沟通目标"'));
  assert(html.includes('aria-label="发送"'));
  assert(html.includes('feed-transcript'));
});
