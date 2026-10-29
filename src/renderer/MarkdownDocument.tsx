import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { insertNewlineContinueMarkupCommand, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { livePreview, mountLivePreview, previewHeadingPrefix } from './grove-live-preview';
import { SharedMarkdown, type MarkdownSourceHooks } from './SharedMarkdown';

export interface MarkdownCompletion { label: string; detail?: string; apply: string; }
export interface MarkdownDocumentProps extends MarkdownSourceHooks {
  identity: string;
  content: string;
  editing: boolean;
  disabled?: boolean;
  headingPrefix?: string;
  bodyLabel?: string;
  maxLength?: number;
  onContentChange(content: string): void;
  onComplete?(query: string): Promise<MarkdownCompletion[]>;
  onPasteImage?(files: File[]): Promise<string[]>;
  onInsertMedia?(files: File[], address: string): Promise<string>;
}

const controlledDocumentLoad = Annotation.define<boolean>();
const richPaste = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
richPaste.use(gfm);
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
const playableFile = (file: File) => /^(audio|video)\//.test(file.type) || /\.(?:mp3|m4a|wav|ogg|mp4|webm)$/i.test(file.name);
const mediaAddress = (value: string) => /^https?:\/\/[^\r\n]+\.(?:mp3|m4a|wav|ogg|mp4|webm)(?:[?#].*)?$/i.test(value);

export function MarkdownDocument(input: MarkdownDocumentProps) {
  const { content, editing, disabled = false, headingPrefix } = input;
  const props = useRef(input); props.current = input;
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const newline = useRef(content.match(/\r\n?|\n/)?.[0] ?? '\n');
  const emitted = useRef<string | null>(null), alive = useRef(false), restoreFocus = useRef(false);
  const mode = useRef(new Compartment()), headings = useRef(new Compartment());
  const [pasteError, setPasteError] = useState('');
  const [editorMounted, setEditorMounted] = useState(editing);
  const [previews, setPreviews] = useState(new Map<HTMLElement, string>());
  const mounted = useRef(new Map<HTMLElement, string>()), pendingFlush = useRef(false);
  const mount = useRef((element: HTMLElement, source: string | null) => {
    if (source === null) mounted.current.delete(element); else mounted.current.set(element, source);
    if (pendingFlush.current) return;
    pendingFlush.current = true;
    queueMicrotask(() => { pendingFlush.current = false; if (alive.current) setPreviews(new Map(mounted.current)); });
  });
  const sourceLength = (doc: EditorState['doc']) => doc.length + (doc.lines - 1) * (newline.current.length - 1);
  const readOnly = () => [EditorState.readOnly.of(!props.current.editing || !!props.current.disabled), EditorView.editable.of(props.current.editing && !props.current.disabled)];
  useEffect(() => { if (editing) setEditorMounted(true); }, [editing]);
  useEffect(() => {
    if (!host.current || !editorMounted) return;
    alive.current = true;
    function allowed(editor: EditorView) { return alive.current && editor.dom.isConnected && editor === view.current && props.current.editing && !props.current.disabled; }
    function insertBlock(editor: EditorView, text: string, kind: string) {
      if (!allowed(editor)) return;
      const { from, to } = editor.state.selection.main;
      const before = editor.state.sliceDoc(0, from), after = editor.state.sliceDoc(to);
      const leading = before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : '';
      const trailing = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      const insert = `${leading}${text}${trailing}`;
      if (sourceLength(editor.state.toText(before + insert + after)) > Math.max(props.current.maxLength ?? 131072, sourceLength(editor.state.doc))) { setPasteError(`${kind}插入后超过正文长度上限。`); return; }
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
      editor.focus();
    }
    async function complete(context: CompletionContext) {
      if (!props.current.onComplete) return null;
      const match = /(?:^|[\s(])@([^\n@\[\]()]{0,80})$/.exec(context.state.sliceDoc(Math.max(0, context.pos - 82), context.pos));
      if (!match) return null;
      const options = await props.current.onComplete(match[1].trim());
      return context.aborted || !alive.current ? null : { from: context.pos - match[1].length - 1, filter: false, options };
    }
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: props.current.content.replace(/\r\n?/g, '\n'), extensions: [
      markdown({ base: markdownLanguage }), history(), EditorView.lineWrapping,
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      Prec.highest(keymap.of([{ key: 'Enter', run: editor => {
        const before = editor.state, selection = before.selection.main;
        const emptyListAtEnd = before.selection.ranges.length === 1 && selection.empty && selection.head === before.doc.length && /^\s*(?:[-+*]|\d+[.)])\s*$/.test(before.doc.lineAt(selection.head).text);
        if (!continueMarkup(editor)) return false;
        const after = editor.state;
        if (emptyListAtEnd && after.doc.length < before.doc.length && after.doc.lines > 1 && after.selection.main.head === after.doc.length && !after.doc.lineAt(after.doc.length).text) { const end = after.doc.length; editor.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, scrollIntoView: true }); }
        return true;
      } }])),
      autocompletion({ override: [complete], activateOnTyping: true, interactionDelay: 0 }),
      mode.current.of(readOnly()), headings.current.of(previewHeadingPrefix.of(props.current.editing ? props.current.headingPrefix ?? '' : '')),
      livePreview, mountLivePreview(mount.current),
      EditorView.contentAttributes.of({ 'aria-label': props.current.bodyLabel ?? '工作项正文', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' }),
      // Existing large files can still be loaded, shortened and undone.
      EditorState.changeFilter.of(transaction => !transaction.isUserEvent('input') || sourceLength(transaction.newDoc) <= Math.max(props.current.maxLength ?? 131072, sourceLength(transaction.startState.doc))),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || !update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(controlledDocumentLoad))) return;
        const value = update.state.doc.sliceString(0, update.state.doc.length, newline.current);
        emitted.current = value; setPasteError(''); props.current.onContentChange(value);
      }),
      EditorView.domEventHandlers({
        paste(event, editor) {
          if (!allowed(editor)) return false;
          if (event.target instanceof Element && event.target.closest('th[contenteditable],td[contenteditable]')) return false;
          const files = Array.from(event.clipboardData?.files ?? []), mediaFiles = files.filter(playableFile);
          const pasted = event.clipboardData?.getData('text/plain').trim() ?? '';
          const address = /^(["']).*\1$/.test(pasted) ? pasted.slice(1, -1) : pasted;
          if (props.current.onInsertMedia && (mediaFiles.length || mediaAddress(address))) {
            event.preventDefault(); setPasteError('');
            void props.current.onInsertMedia(mediaFiles, address).then(text => insertBlock(editor, text, '媒体')).catch(error => { if (allowed(editor)) setPasteError(`媒体导入失败：${String(error)}`); });
            return true;
          }
          const images = files.filter(file => file.type.startsWith('image/'));
          if (images.length) {
            event.preventDefault();
            if (images.some(file => !/^image\/(?:png|jpeg|webp|gif)$/.test(file.type))) { setPasteError('请粘贴 PNG、JPEG、WebP 或 GIF 图片。'); return true; }
            if (!props.current.onPasteImage) { setPasteError('当前来源无法保存图片。'); return true; }
            setPasteError('');
            void props.current.onPasteImage(images).then(urls => insertBlock(editor, urls.map(url => `![图片](${url})`).join('\n\n'), '图片')).catch(error => { if (allowed(editor)) setPasteError(`图片导入失败：${String(error)}`); });
            return true;
          }
          const html = event.clipboardData?.getData('text/html');
          const markdownText = event.clipboardData?.getData('text/markdown') || (html && richPaste.turndown(html));
          const text = markdownText || event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text/uri-list');
          if (!text) return false;
          const selection = editor.state.selection.main, line = editor.state.doc.lineAt(selection.from), paste = editor.state.toText(text), pasteText = paste.toString();
          if (markdownText && (pasteText.includes('\n') || /^(?:#{1,6}\s|[-+*]\s|\d+\.\s|>|\|)/.test(pasteText) || /<(?:h[1-6]|p|ul|ol|li|blockquote|pre|table|hr)\b/i.test(html ?? ''))) {
            const before = editor.state.sliceDoc(0, selection.from), after = editor.state.sliceDoc(selection.to);
            const leading = before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : '';
            const trailing = after && !after.startsWith('\n\n') ? after.startsWith('\n') ? '\n' : '\n\n' : '';
            editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: `${leading}${pasteText}${trailing}` }, selection: { anchor: selection.from + leading.length + paste.length }, userEvent: 'input.paste', scrollIntoView: true });
            return true;
          }
          // A visible empty line must not collapse into a Markdown soft break on paste.
          if (editor.state.selection.ranges.length === 1 && selection.empty && selection.from === line.from && !line.length && line.number > 1 && pasteText.trim() && !pasteText.startsWith('\n')) {
            const previous = editor.state.doc.line(line.number - 1), block = markdownLanguage.parser.parse(editor.state.sliceDoc(0, previous.to)).topNode.lastChild;
            if (previous.text.trim() && block?.name === 'Paragraph' && block.to === previous.to && !previous.text.endsWith('  ')) {
              const spaces = previous.text.endsWith(' ') ? ' ' : '  ', trailing = line.number < editor.state.doc.lines && editor.state.doc.line(line.number + 1).text.trim() && !pasteText.endsWith('\n') ? '\n' : '';
              editor.dispatch({ changes: { from: previous.to, to: selection.from, insert: `${spaces}\n${pasteText}${trailing}` }, selection: { anchor: previous.to + spaces.length + 1 + paste.length }, userEvent: 'input.paste', scrollIntoView: true }); return true;
            }
          }
          editor.dispatch(editor.state.replaceSelection(paste), { userEvent: 'input.paste', scrollIntoView: true }); return true;
        },
        dragover(event) { if (!props.current.onInsertMedia || !props.current.editing || props.current.disabled || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return false; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; return true; },
        drop(event, editor) {
          const files = Array.from(event.dataTransfer?.files ?? []), images = files.filter(file => /^image\/(?:png|jpeg|webp|gif)$/.test(file.type)), media = files.filter(playableFile);
          if (!allowed(editor) || !images.length && !media.length) return false;
          const insert = images.length && props.current.onPasteImage ? props.current.onPasteImage(images).then(urls => urls.map(url => `![图片](${url})`).join('\n\n')) : media.length && props.current.onInsertMedia ? props.current.onInsertMedia(media, '') : null;
          if (!insert) return false;
          event.preventDefault(); const position = editor.posAtCoords({ x: event.clientX, y: event.clientY }); if (position !== null) editor.dispatch({ selection: { anchor: position } });
          void insert.then(text => insertBlock(editor, text, '媒体')).catch(error => { if (allowed(editor)) setPasteError(`媒体导入失败：${String(error)}`); }); return true;
        },
      }),
    ] }) });
    view.current = editor;
    return () => { alive.current = false; view.current = null; editor.destroy(); mounted.current.clear(); };
  }, [editorMounted]);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    if (disabled && editor.hasFocus) restoreFocus.current = true;
    editor.dispatch({ effects: [mode.current.reconfigure(readOnly()), headings.current.reconfigure(previewHeadingPrefix.of(editing ? headingPrefix ?? '' : ''))] });
    if (!disabled && restoreFocus.current) { if (editing && (document.activeElement === document.body || document.activeElement === editor.contentDOM)) editor.focus(); restoreFocus.current = false; }
    editor.requestMeasure();
  }, [editing, disabled, headingPrefix, editorMounted]);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    const normalized = content.replace(/\r\n?/g, '\n'), ownEcho = content === emitted.current && editor.state.doc.toString() === normalized; emitted.current = null;
    if (ownEcho) return;
    newline.current = content.match(/\r\n?|\n/)?.[0] ?? newline.current;
    if (editor.state.doc.toString() !== normalized) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: normalized }, annotations: [Transaction.addToHistory.of(false), controlledDocumentLoad.of(true)] });
  }, [content, editorMounted]);
  const hooks = { onOpenLink: input.onOpenLink, renderLink: input.renderLink, resolveResource: input.resolveResource };
  const tree = markdownLanguage.parser.parse(content.replace(/\r\n?/g, '\n'));
  const definitions: string[] = [], headingStarts: number[] = [];
  tree.iterate({ enter(node) { if (node.name === 'LinkReference') definitions.push(content.replace(/\r\n?/g, '\n').slice(node.from, node.to)); if (/^(ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) headingStarts.push(node.from); } });
  const referenceContext = definitions.length ? `\n\n${definitions.join('\n')}\n` : '';
  return <div className={`document-live-editor markdown-editor${editing ? ' is-editing' : ''}`}>
    <div className="markdown-mode-body" hidden={editing}><SharedMarkdown content={content} headingPrefix={editing ? undefined : headingPrefix} {...hooks} /></div>
    {editorMounted && <div className="markdown-mode-body" hidden={!editing}><div ref={host} />{[...previews].map(([element, source]) => createPortal(<SharedMarkdown content={source + referenceContext} headingPrefix={editing ? headingPrefix : undefined} headingOffset={headingStarts.filter(from => from < Number(element.dataset.previewFrom)).length} {...hooks} />, element, element.dataset.previewFrom))}</div>}
    {pasteError && <p className="markdown-paste-error inline-error" role="alert">{pasteError}</p>}
  </div>;
}
