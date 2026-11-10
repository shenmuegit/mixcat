import { useEffect, useRef, useState } from 'react';
import { submitFeedOnEnter, useFeedForm, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { FeedModelPicker } from './FeedModelPicker';
import { Icon } from './Icon';
const emptyCollection = { instruction: '', name: '', directory: '', model: null as string | null, reasoningEffort: null as string | null };

export function FeedNewCollection({ drafts, execute, disabled, onBack, onAccepted, navigation, onError }: { drafts: FeedDraftPort; execute: FeedExecute; disabled: boolean; onBack(): void; onAccepted(id: string, epoch: number): void; navigation(): number; onError(message: string): void }) {
  const form = useFeedForm('collection:new', emptyCollection, drafts), fields = { ...emptyCollection, ...form.value.fields };
  const [error, setError] = useState(''), [choosing, setChoosing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), alive = useRef(true), latest = useRef(fields); latest.current = fields;
  useEffect(() => { input.current?.focus(); return () => { alive.current = false; }; }, []);
  const capabilities = { model: fields.model, reasoningEffort: fields.reasoningEffort, skills: [], plugins: [] };
  async function choose() {
    const epoch = navigation(); setChoosing(true); setError('');
    try { const directory = await window.mixcat.chooseDirectory(); if (directory && alive.current && epoch === navigation()) form.change({ ...latest.current, directory }); }
    catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setChoosing(false); }
  }
  async function submit() {
    const epoch = navigation(); setError('');
    try {
      const reply = await form.submit({ type: 'create_feed_collection', requestId: crypto.randomUUID(), name: fields.name.trim() || fields.instruction.trim().slice(0, 36), ...(fields.directory ? { directory: fields.directory } : {}), capabilities, instruction: '', input: { text: fields.instruction, capabilities }, trigger: 'message' }, execute, emptyCollection);
      if (reply?.admission) onAccepted(reply.admission.collectionId, epoch);
    } catch (caught) { setError(String(caught)); onError(String(caught)); }
  }
  return <section className="feed-new"><button className="button secondary" onClick={onBack}><Icon name="back" size={16} />返回信息流</button><h2>新建采集</h2><form className="form-stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label>采集名称<input aria-label="采集名称" maxLength={512} readOnly={!form.ready} value={fields.name} placeholder="例如：行业每日简报" onChange={event => form.change({ ...fields, name: event.target.value })} /></label>
    <label>工作目录<div className="input-with-button"><input aria-label="工作目录" readOnly value={fields.directory} placeholder="默认使用应用内工作目录" /><button type="button" className="button secondary" disabled={disabled || choosing || !form.ready} onClick={() => void choose()}>选择目录</button></div></label>
    <div className="feed-message-form"><textarea ref={input} aria-label="采集需求" rows={4} readOnly={!form.ready} value={fields.instruction} placeholder="你想持续关注什么？" onChange={event => form.change({ ...fields, instruction: event.target.value })} onKeyDown={event => submitFeedOnEnter(event, instruction => form.change({ ...fields, instruction }))} />
      <div className="feed-composer-footer"><span className="field-note">{!form.ready && '草稿读取成功后可编辑。'}</span><div className="feed-composer-controls"><FeedModelPicker value={capabilities} execute={execute} disabled={disabled || !form.ready || form.busy} onChange={patch => form.change({ ...fields, ...patch })} /><button type="submit" className="feed-send" aria-label={form.value.pending ? '重试原提交' : '发送'} disabled={disabled || form.busy || choosing || !form.ready || !form.value.pending && !fields.instruction.trim()}><span className="feed-visually-hidden">{form.value.pending ? '重试原提交' : '发送'}</span><Icon name="arrow" size={20} /></button></div></div>
    </div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {form.value.pending && <p role="status">上次提交尚待确认；重试会核实原提交，新编辑的内容保留为下一份草稿。</p>}
  </form></section>;
}
