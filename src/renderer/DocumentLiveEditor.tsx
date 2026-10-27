import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import type { Token } from 'marked';
import { itemLink, itemNumber } from '../shared/project-items';
import type { AppCommand, AppReply } from '../shared/types';
import { ProjectMarkdown, itemKinds } from './ProjectMarkdown';
import { livePreview, type PreviewMount } from './document-live-preview';

export function DocumentLiveEditor({ value, editing, disabled, projectId, execute, onChange, headingPrefix }: {
  value: string; editing: boolean; disabled: boolean; projectId: string; headingPrefix: string;
  execute(command: AppCommand): Promise<AppReply | null>; onChange(value: string): void;
}) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const props = useRef({ value, editing, disabled, projectId, execute, onChange }); props.current = { value, editing, disabled, projectId, execute, onChange };
  const mode = useRef(new Compartment()), preview = useRef(new Compartment()), newline = useRef(value.includes('\r\n') ? '\r\n' : '\n');
  const restoreFocus = useRef(false);
  const [previews, setPreviews] = useState(new Map<HTMLElement, { token: Token; headingOffset: number }>());
  const mounted = useRef(new Map<HTMLElement, { token: Token; headingOffset: number }>()), flushPending = useRef(false), alive = useRef(false);
  const mount = useRef<PreviewMount>((element, token, headingOffset) => {
    if (token) mounted.current.set(element, { token, headingOffset }); else mounted.current.delete(element);
    if (flushPending.current) return;
    flushPending.current = true;
    queueMicrotask(() => { flushPending.current = false; if (alive.current) setPreviews(new Map(mounted.current)); });
  });
  const extensions = () => [EditorState.readOnly.of(!props.current.editing || props.current.disabled), EditorView.editable.of(props.current.editing && !props.current.disabled)];
  useEffect(() => {
    if (!host.current) return;
    alive.current = true;
    async function complete(context: CompletionContext) {
      const before = context.state.sliceDoc(Math.max(0, context.pos - 82), context.pos);
      const match = /(?:^|[\s(])@([^\n@\[\]()]{0,80})$/.exec(before);
      if (!match) return null;
      const from = context.pos - match[1].length - 1;
      const reply = await props.current.execute({ type: 'search_project_items', projectId: props.current.projectId, query: { text: match[1].trim(), limit: 20 } });
      if (context.aborted) return null;
      return { from, filter: false, options: (reply?.projectItems?.items ?? []).map(item => ({ label: `${itemNumber(item)} ${item.title}`, detail: itemKinds[item.kind], apply: `${itemLink(props.current.projectId, item)} ` })) };
    }
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: props.current.value, extensions: [
      EditorState.lineSeparator.of(newline.current), markdown(), history(), EditorView.lineWrapping,
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      autocompletion({ override: [complete], activateOnTyping: true, interactionDelay: 0 }), mode.current.of(extensions()), preview.current.of(livePreview(props.current.editing, mount.current, headingPrefix)),
      EditorView.contentAttributes.of({ 'aria-label': '工作项正文', role: 'textbox', 'aria-multiline': 'true' }),
      // Existing files can exceed the typing cap; loading, undo and shortening must still work.
      EditorState.changeFilter.of(transaction => !transaction.isUserEvent('input') || transaction.newDoc.length <= Math.max(131072, transaction.startState.doc.length)),
      EditorView.updateListener.of(update => { if (update.docChanged && update.transactions.some(transaction => transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) props.current.onChange(update.state.sliceDoc()); }),
    ] }) });
    view.current = editor;
    return () => { alive.current = false; editor.destroy(); view.current = null; mounted.current.clear(); };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (disabled && editor.hasFocus) restoreFocus.current = true;
    editor.dispatch({ effects: mode.current.reconfigure(extensions()) });
    if (!disabled && restoreFocus.current) {
      if (editing && (document.activeElement === document.body || document.activeElement === editor.contentDOM)) editor.focus();
      restoreFocus.current = false;
    }
  }, [editing, disabled]);
  useEffect(() => {
    view.current?.dispatch({ effects: preview.current.reconfigure(livePreview(editing, mount.current, headingPrefix)) });
  }, [editing, headingPrefix]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.sliceDoc() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
  }, [value]);
  return <div className={`document-live-editor${editing ? ' is-editing' : ''}`}>
    <div ref={host} />
    {[...previews].map(([element, preview]) => createPortal(<ProjectMarkdown text="" tokens={[preview.token]} headingPrefix={headingPrefix} headingOffset={preview.headingOffset} />, element, element.dataset.sourceFrom))}
  </div>;
}
