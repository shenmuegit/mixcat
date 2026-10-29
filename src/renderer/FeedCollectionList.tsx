import { useEffect, useRef, useState } from 'react';
import type { FeedCollectionSummary } from '../shared/feed';
import { feedTime, feedRunLabel, scheduleLabel } from './FeedCollection';
import { useFeedForm, useFeedPage, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { Icon } from './Icon';
const emptyCollection = { instruction: '' };
export function FeedNewCollection({ drafts, execute, disabled, onBack, onAccepted, navigation, onError }: { drafts: FeedDraftPort; execute: FeedExecute; disabled: boolean; onBack(): void; onAccepted(id: string, epoch: number): void; navigation(): number; onError(message: string): void }) {
  // Keep the historical draft field and key so unsent text and immutable pending commands survive upgrades.
  const form = useFeedForm('collection:new', emptyCollection, drafts), fields = form.value.fields;
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  async function submit() {
    const epoch = navigation(); setError('');
    try {
      const reply = await form.submit({ type: 'create_feed_collection', requestId: crypto.randomUUID(), name: fields.instruction.trim().slice(0, 36), instruction: '', input: { text: fields.instruction }, trigger: 'message' }, execute, emptyCollection);
      if (reply?.admission) onAccepted(reply.admission.collectionId, epoch);
    } catch (caught) { setError(String(caught)); onError(String(caught)); }
  }
  return <section className="feed-new"><button className="button secondary" onClick={onBack}><Icon name="back" size={16} />返回信息流</button><h2>新建采集</h2><form className="form-stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label>和 Codex 沟通采集目标<textarea ref={input} aria-label="采集需求" rows={7} readOnly={!form.ready} value={fields.instruction} placeholder="你想持续关注什么？" onChange={event => form.change({ ...fields, instruction: event.target.value })} /></label>
    {!form.ready && <p className="field-note">草稿读取成功后可编辑。</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {form.value.pending && <p role="status">上次提交尚待确认；重试会核实原提交，新编辑的文字保留为下一份草稿。</p>}
    <div className="feed-actions"><button className="button primary" disabled={disabled || form.busy || !form.ready || !form.value.pending && !fields.instruction.trim()}>{form.value.pending ? '重试原提交' : '发送'}<Icon name="arrow" size={16} /></button></div>
  </form></section>;
}
export function FeedCollectionList({ execute, revision, onOpen, onNew, onError, disabled = false }: { execute: FeedExecute; revision: string; onOpen(id: string, button: HTMLButtonElement): void; onNew(button: HTMLButtonElement): void; onError(message: string): void; disabled?: boolean }) {
  const page = useFeedPage<FeedCollectionSummary>({ type: 'list_feed_collections' }, 'collectionPage', execute, revision, onError);
  return <section className="feed-collection-list" aria-label="采集任务">
    {page.items.length ? <div className="project-grid">{page.items.map(item => <button className="project-card feed-card" type="button" key={item.id} aria-label={item.name} onClick={event => onOpen(item.id, event.currentTarget)}>
      <div className="project-card-top"><span className="project-icon"><Icon name="nodes" size={22} /></span><span className="feed-card-status">{item.requestCount || item.attentionCount ? '需要你处理' : item.queueHeld ? '队列待继续' : item.activeRun ? feedRunLabel(item.activeRun) : scheduleLabel(item.schedule)}</span></div>
      <h2>{item.name}</h2><p className="feed-card-objective">{item.instruction || '待沟通目标'}</p>
      {item.latestResult ? <div className="feed-card-result"><h3>{item.latestResult.title}</h3><p>{item.latestResult.excerpt}</p><time dateTime={item.latestResult.collectedAt}>{feedTime(item.latestResult.collectedAt)}</time></div> : <p className="muted">尚无执行结果</p>}
    </button>)}</div> : <section className="empty-workspace"><Icon name="nodes" size={32} /><h2>从一个采集开始</h2><p>和 Codex 沟通目标，定时收集你关注的信息。</p><button className="button secondary" disabled={disabled} onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={16} />新建采集</button></section>}
    {page.cursor && <button className="button secondary" disabled={page.loading} onClick={() => void page.more()}>加载更多采集</button>}
  </section>;
}
