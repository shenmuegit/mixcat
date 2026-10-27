import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { marked, type Token } from 'marked';

export type PreviewMount = (element: HTMLElement, token: Token | null, headingOffset: number) => void;

class MarkdownBlock extends WidgetType {
  readonly signature: string;
  constructor(readonly token: Token, readonly offset: number, readonly from: number, readonly editing: boolean, readonly mount: PreviewMount) { super(); this.signature = JSON.stringify(token); }
  eq(other: MarkdownBlock) { return this.from === other.from && this.offset === other.offset && this.editing === other.editing && this.signature === other.signature; }
  toDOM(view: EditorView) {
    const element = document.createElement('div');
    element.className = 'document-preview-block';
    element.dataset.sourceFrom = String(this.from);
    this.mount(element, this.token, this.offset);
    if (this.editing) element.addEventListener('mousedown', event => {
      if ((event.target as HTMLElement).closest('button,a,input')) return;
      event.preventDefault();
      const position = this.from;
      view.dispatch({ selection: { anchor: position } });
      view.focus();
    });
    return element;
  }
  destroy(element: HTMLElement) { this.mount(element, null, this.offset); }
  ignoreEvent() { return true; }
}

export function livePreview(editing: boolean, mount: PreviewMount, headingPrefix: string) {
  function decorations(state: EditorState) {
    const ranges: Range<Decoration>[] = [], selection = state.selection.main;
    const tokens = marked.lexer(state.doc.toString());
    let from = 0, headingOffset = 0;
    for (const token of tokens) {
      const to = from + token.raw.replace(/\n+$/, '').length;
      const active = editing && selection.from <= to && selection.to >= from;
      let count = 0;
      let searchFrom = 0;
      marked.walkTokens([token], value => {
        if (value.type !== 'heading') return;
        if (active) {
          const position = Math.max(searchFrom, token.raw.indexOf(value.raw, searchFrom));
          ranges.push(Decoration.line({ attributes: { id: `${headingPrefix}-${headingOffset + count}`, tabindex: '-1' } }).range(state.doc.lineAt(from + position).from));
          searchFrom = position + value.raw.length;
        }
        count++;
      });
      if (to > from && token.type !== 'space' && !active) {
        ranges.push(Decoration.replace({ widget: new MarkdownBlock(token, headingOffset, from, editing, mount), block: true }).range(from, to));
      }
      headingOffset += count; from += token.raw.length;
    }
    return Decoration.set(ranges, true);
  }
  return StateField.define<DecorationSet>({
    create: decorations,
    update: (value, transaction) => transaction.docChanged || transaction.selection ? decorations(transaction.state) : value,
    provide: field => EditorView.decorations.from(field),
  });
}
