import { sourceCharacters } from "./markdown-source";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { Facet, Prec, StateEffect, StateField, type ChangeSpec, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isBase64ImageUrl, markdownUrlTransform } from "./markdown-url";

type Cell = { from: number; to: number };
type SyntaxNode = ReturnType<typeof markdownLanguage.parser.parse>["topNode"];
type CellDOM = Array<{ node: Node; children: Node[]; text: string | null }>;
type TableState = { block: PreviewBlock; view: EditorView; texts: WeakMap<HTMLElement, string>; dom: WeakMap<HTMLElement, CellDOM>; observer?: MutationObserver };
const tables = new WeakMap<HTMLElement, TableState>();
type MountBlock = (element: HTMLElement, content: string | null) => void;
const mountedBlocks = Facet.define<MountBlock, MountBlock | null>({ combine: (values) => values.at(-1) ?? null });
export const mountLivePreview = (mount: MountBlock) => mountedBlocks.of(mount);
export const previewHeadingPrefix = Facet.define<string, string>({ combine: values => values.at(-1) ?? "" });
const renderedImages = new WeakMap<HTMLElement, PreviewBlock | PreviewImage>();

function tableCells(content: string): Cell[][] {
  const table = markdownLanguage.parser.parse(content).topNode.firstChild;
  if (table?.name !== "Table") return [];
  const rows: Cell[][] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
    const pipes = row.getChildren("TableDelimiter");
    const cells: Cell[] = [];
    let start = pipes[0]?.from === row.from ? pipes[0].to : row.from;
    for (const pipe of pipes) {
      if (pipe.from < start) continue;
      const left = content.slice(start, pipe.from).match(/^\s*/)?.[0].length ?? 0;
      const right = content.slice(start, pipe.from).match(/\s*$/)?.[0].length ?? 0;
      cells.push({ from: start + left, to: Math.max(start + left, pipe.from - right) });
      start = pipe.to;
    }
    if (start < row.to) {
      const left = content.slice(start, row.to).match(/^\s*/)?.[0].length ?? 0;
      const right = content.slice(start, row.to).match(/\s*$/)?.[0].length ?? 0;
      cells.push({ from: start + left, to: Math.max(start + left, row.to - right) });
    }
    rows.push(cells);
  }
  return rows;
}

function sourcePositionAtPoint(content: string, element: HTMLElement, x: number, y: number): number | null {
  const caret = document.caretPositionFromPoint?.(x, y);
  const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  const before = range.toString();
  const visible = element.textContent ?? "";
  const { text, spans } = sourceCharacters(content, { from: 0, to: content.length });
  const positions: number[] = [];
  for (let index = 0; index < text.length; index++) if (!/\s/.test(text[index])) positions.push(index);
  const rendered = visible.replace(/\s/g, "");
  if (!positions.length || rendered.length !== positions.length
    || positions.some((position, index) => text[position] !== rendered[index])) return null;
  const count = before.replace(/\s/g, "").length;
  if (count === 0) return spans[positions[0]].from;
  if (count >= positions.length) return spans[positions.at(-1)!].to;
  if (node.nodeType === Node.TEXT_NODE && offset === 0) return spans[positions[count]].from;
  const previous = spans[positions[count - 1]].to;
  let whitespace = before.match(/\s+$/)?.[0].length ?? 0;
  let position = previous;
  for (let index = positions[count - 1] + 1; index < positions[count] && whitespace; index++) {
    if (/\s/.test(text[index])) { position = spans[index].to; whitespace--; }
  }
  return position;
}

function rememberTableCell(state: TableState, element: HTMLElement) {
  const snapshot: CellDOM = [];
  const visit = (node: Node) => { const children = Array.from(node.childNodes); snapshot.push({ node, children, text: node.nodeType === Node.TEXT_NODE ? node.textContent : null }); children.forEach(visit); };
  visit(element);
  state.dom.set(element, snapshot);
}

function applyTableChange(state: TableState, element: HTMLElement, before: string, changes: ChangeSpec) {
  const transaction = state.view.state.update({ changes, userEvent: "input" });
  if (transaction.docChanged) state.view.dispatch(transaction);
  else {
    // Retain the original nodes so source-specific links and media keep their handlers.
    for (const { node, children, text } of state.dom.get(element) ?? []) {
      if (text !== null) node.textContent = text;
      else if (node instanceof Element) node.replaceChildren(...children);
    }
    state.texts.set(element, before);
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }
  state.view.requestMeasure();
}

function syncTableCell(state: TableState, element: HTMLElement, before: string, after: string) {
  if (state.view.state.readOnly) { renderTable(element.closest<HTMLElement>(".live-preview-block")!, state); return; }
  if (before === after) return;
  const row = element.parentElement;
  const rows = [...(row?.parentElement?.parentElement?.querySelectorAll("tr") ?? [])];
  const cell = tableCells(state.block.content)[rows.indexOf(row as HTMLTableRowElement)]?.[[...(row?.children ?? [])].indexOf(element)];
  if (!cell) return;
  const { text, spans } = sourceCharacters(state.block.content, cell);
  if (text !== before) {
    // shortcut: unknown inline syntax rewrites only the edited cell; extend the source mapping if this occurs in real documents.
    applyTableChange(state, element, before, {
      from: state.block.from + cell.from,
      to: state.block.from + cell.to,
      insert: after.replace(/\|/g, "\\|").replace(/\r?\n/g, " "),
    });
    return;
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const from = prefix < before.length - suffix ? spans[prefix].from
    : prefix < spans.length ? spans[prefix].from : spans.at(-1)?.to ?? cell.from;
  const to = prefix < before.length - suffix ? spans[before.length - suffix - 1].to : from;
  const insert = after.slice(prefix, after.length - suffix).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  applyTableChange(state, element, before, { from: state.block.from + from, to: state.block.from + to, insert });
}

function configureTable(element: HTMLElement, state: TableState) {
  const { block } = state;
  const spans = tableCells(block.content);
  element.querySelectorAll("tr").forEach((row, rowIndex) => {
    row.querySelectorAll<HTMLElement>("th, td").forEach((cell, columnIndex) => {
      if (!spans[rowIndex]?.[columnIndex]) return;
      cell.contentEditable = String(!state.view.state.readOnly);
      cell.spellcheck = true;
      state.texts.set(cell, sourceCharacters(block.content, spans[rowIndex][columnIndex]).text);
    });
  });
}

function renderTable(element: HTMLElement, state: TableState) {
  const { block } = state;
  if (block.mount) block.mount(element, block.content);
  else element.innerHTML = renderToStaticMarkup(<ReactMarkdown urlTransform={markdownUrlTransform} remarkPlugins={[remarkGfm]}>{block.content + block.references}</ReactMarkdown>);
  configureTable(element, state);
}

class PreviewBlock extends WidgetType {
  constructor(readonly content: string, readonly from: number, readonly kind: string,
    readonly mount: MountBlock | null, readonly selected = false, readonly references = "") { super(); }

  eq(other: PreviewBlock) { return this.content === other.content && this.from === other.from
    && this.kind === other.kind && this.mount === other.mount && this.selected === other.selected && this.references === other.references; }

  ignoreEvent() { return this.kind === "Table" || Boolean(this.mount); }

  destroy(element: HTMLElement) { tables.get(element)?.observer?.disconnect(); this.mount?.(element, null); }

  updateDOM(element: HTMLElement, view: EditorView) {
    if (this.kind === "Base64Image") {
      const previous = renderedImages.get(element);
      if (!(previous instanceof PreviewBlock) || previous.content !== this.content
        || previous.from !== this.from || previous.mount !== this.mount) return false;
      renderedImages.set(element, this);
      element.classList.toggle("is-selected", this.selected);
      return true;
    }
    const state = tables.get(element);
    if (this.kind !== "Table" || !state) return false;
    element.dataset.previewFrom = String(this.from);
    state.block = this;
    state.view = view;
    if (!element.contains(document.activeElement)) renderTable(element, state);
    return true;
  }

  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "live-preview-block document-preview-block";
    element.classList.toggle("is-selected", this.selected);
    if (this.kind === "Base64Image") renderedImages.set(element, this);
    element.dataset.previewFrom = String(this.from);
    element.dataset.previewKind = this.kind;
    if (this.kind === "Table") {
      const state: TableState = { block: this, view, texts: new WeakMap(), dom: new WeakMap() };
      tables.set(element, state);
      state.observer = new MutationObserver(() => { configureTable(element, state); state.view.requestMeasure(); });
      state.observer.observe(element, { childList: true, subtree: true });
      renderTable(element, state);
      element.addEventListener("compositionstart", event => {
        const cell = (event.target as Element).closest<HTMLElement>("th[contenteditable],td[contenteditable]");
        if (cell) rememberTableCell(state, cell);
      });
      element.addEventListener("input", (event) => {
        const cell = (event.target as Element).closest<HTMLElement>("th[contenteditable], td[contenteditable]");
        if (!cell || (event as InputEvent).isComposing) return;
        const before = state.texts.get(cell) ?? "";
        const after = cell.textContent ?? "";
        state.texts.set(cell, after);
        syncTableCell(state, cell, before, after);
      });
      element.addEventListener("compositionend", (event) => {
        const cell = (event.target as Element).closest<HTMLElement>("th[contenteditable], td[contenteditable]");
        if (!cell) return;
        const before = state.texts.get(cell) ?? "";
        const after = cell.textContent ?? "";
        state.texts.set(cell, after);
        syncTableCell(state, cell, before, after);
      });
      element.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
          const cell = (event.target as Element).closest("th[contenteditable],td[contenteditable]");
          if (cell) { event.preventDefault(); event.stopPropagation(); const range = document.createRange(); range.selectNodeContents(cell); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
        }
        if ((event.ctrlKey || event.metaKey) && !event.isComposing && ["z", "y"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
          (event.key.toLowerCase() === "y" || event.shiftKey ? redo : undo)(state.view);
          renderTable(element, state);
        }
        if (event.key === "Enter" && (event.target as Element).closest("th[contenteditable], td[contenteditable]")) event.preventDefault();
      });
      element.addEventListener("beforeinput", (event) => {
        if (state.view.state.readOnly) { event.preventDefault(); return; }
        const cell = (event.target as Element).closest<HTMLElement>("th[contenteditable],td[contenteditable]");
        if (cell && !(event as InputEvent).isComposing) rememberTableCell(state, cell);
        if (["insertParagraph", "insertLineBreak"].includes((event as InputEvent).inputType)) event.preventDefault();
      });
      element.addEventListener("paste", (event) => {
        const cell = (event.target as Element).closest<HTMLElement>("th[contenteditable], td[contenteditable]");
        if (!cell) return;
        event.preventDefault();
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!cell.contains(range.commonAncestorContainer)) return;
        rememberTableCell(state, cell);
        const inserted = document.createTextNode(event.clipboardData?.getData("text/plain").replace(/\s*\r?\n\s*/g, " ") ?? "");
        range.deleteContents();
        range.insertNode(inserted);
        range.setStartAfter(inserted);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        const before = state.texts.get(cell) ?? "";
        const after = cell.textContent ?? "";
        state.texts.set(cell, after);
        syncTableCell(state, cell, before, after);
      });
      element.addEventListener("focusout", (event) => {
        if (!element.contains(event.relatedTarget as Node)) renderTable(element, state);
      });
    } else if (this.mount) {
      this.mount(element, this.content);
    } else {
      element.innerHTML = renderToStaticMarkup(
        <ReactMarkdown urlTransform={markdownUrlTransform} remarkPlugins={[remarkGfm]}>{this.content}</ReactMarkdown>,
      );
    }
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const image = event.target instanceof Element ? event.target.closest("img") : null;
      const imageUrl = image && element.contains(image) ? image.getAttribute("src") ?? "" : "";
      const interactive = (event.target as Element).closest("audio, video, button, input, textarea, select, a, [contenteditable=true]");
      if (!isBase64ImageUrl(imageUrl) && this.mount && interactive && element.contains(interactive)) {
        event.stopPropagation();
        return;
      }
      if (this.kind === "Table" && (event.target as Element).closest("th, td")) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      let imageSelection: { anchor: number; head: number } | undefined;
      if (isBase64ImageUrl(imageUrl)) {
        if (this.kind === "Base64Image") {
          imageSelection = { anchor: this.from, head: this.from + this.content.length };
        } else {
          let index = [...element.querySelectorAll("img")].filter((candidate) => candidate.getAttribute("src") === imageUrl).indexOf(image!);
          const cursor = markdownLanguage.parser.parse(this.content).cursor();
          do {
            if (cursor.name !== "Image") continue;
            const url = cursor.node.getChild("URL");
            if (url && this.content.slice(url.from, url.to) === imageUrl && index-- === 0) {
              imageSelection = { anchor: this.from + cursor.from, head: this.from + cursor.to };
              break;
            }
          } while (cursor.next());
        }
      }
      const block = tables.get(element)?.block ?? this;
      const clicked = imageSelection ? null : sourcePositionAtPoint(block.content, element, event.clientX, event.clientY);
      view.dispatch({ selection: imageSelection ?? { anchor: block.from + (clicked ?? 0) } });
      view.focus();
      if (!imageSelection && clicked === null) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position !== null && position >= block.from && position <= block.from + block.content.length) {
          view.dispatch({ selection: { anchor: position } });
        }
      }
    });
    element.addEventListener("click", (event) => {
      const image = (event.target as Element).closest("img");
      const interactive = (event.target as Element).closest("audio, video, button, input, textarea, select, a, [contenteditable=true]");
      if (this.mount && !isBase64ImageUrl(image?.getAttribute("src") ?? "")
        && interactive && element.contains(interactive)) {
        event.stopPropagation();
        return;
      }
      if (this.kind !== "Table" || !(event.target as Element).closest("th, td") || (event.target as Element).closest("a")) event.preventDefault();
      event.stopPropagation();
    });
    element.querySelectorAll("img").forEach((image) => {
      image.addEventListener("load", () => view.requestMeasure(), { once: true });
    });
    return element;
  }
}

class PreviewImage extends WidgetType {
  constructor(readonly content: string, readonly from: number, readonly selected: boolean) { super(); }

  eq(other: PreviewImage) { return this.content === other.content && this.from === other.from
    && this.selected === other.selected; }

  updateDOM(element: HTMLElement) {
    const previous = renderedImages.get(element);
    if (!(previous instanceof PreviewImage) || previous.content !== this.content || previous.from !== this.from) return false;
    renderedImages.set(element, this);
    element.classList.toggle("is-selected", this.selected);
    return true;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform} remarkPlugins={[remarkGfm]}>{this.content}</ReactMarkdown>,
    );
    const image = wrapper.querySelector("img")!;
    image.classList.add("live-preview-image");
    image.classList.toggle("is-selected", this.selected);
    renderedImages.set(image, this);
    image.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from, head: this.from + this.content.length } });
      view.focus();
    });
    image.addEventListener("load", () => view.requestMeasure(), { once: true });
    return image;
  }
}

class SoftBreak extends WidgetType {
  eq() { return true; }
  toDOM() { const span = document.createElement("span"); span.textContent = " "; return span; }
}
const softBreak = new SoftBreak();

function decorate(state: EditorState, focused: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const beforeHeading = new Set<number>();
  const afterHeading = new Set<number>();
  const source = state.doc.toString();
  // shortcut: reparsing each edit is sufficient for chapter-sized documents; use incremental parsing if this becomes slow.
  const tree = markdownLanguage.parser.parse(source);
  const definitions: string[] = [];
  tree.iterate({ enter(node) { if (node.name === "LinkReference") definitions.push(source.slice(node.from, node.to)); } });
  const references = definitions.length ? `\n\n${definitions.join("\n")}\n` : "";
  const prefix = state.facet(previewHeadingPrefix);
  let headingIndex = 0;
  if (prefix) tree.iterate({ enter(node) {
    if (!/^(ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) return;
    const index = headingIndex++;
    if (focused && state.selection.ranges.some(selection => selection.from <= node.to && selection.to >= node.from)) ranges.push(Decoration.line({ attributes: { id: `${prefix}-${index}`, tabindex: "-1" } }).range(state.doc.lineAt(node.from).from));
  } });
  const mount = state.facet(mountedBlocks);
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return Decoration.none;

  const mark = (from: number, to: number, className: string) => {
    if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to));
  };
  const selected = (from: number, to: number) => focused && state.selection.ranges.some(
    (selection) => !selection.empty && selection.from <= from && selection.to >= to,
  );

  do {
    const block = cursor.node;
    const { from, to } = block;
    if (from === to) continue;
    const active = focused && state.selection.ranges.some((selection) => selection.from <= to && selection.to >= from);
    const bareHeading = active && /^ATXHeading[1-6]$/.test(block.name)
      && /^#{1,6}$/.test(source.slice(from, to).trim());
    if (!bareHeading && /^ATXHeading[1-3]$/.test(block.name)) {
      beforeHeading.add(state.doc.lineAt(from).number - 1);
      afterHeading.add(state.doc.lineAt(to - 1).number + 1);
    }
    if ((block.name === "BulletList" || block.name === "OrderedList") && block.nextSibling?.name === "Paragraph") {
      const blanks: number[] = [];
      for (let number = state.doc.lineAt(to - 1).number + 1; number <= state.doc.lines; number++) {
        const line = state.doc.line(number);
        if (line.text.trim()) break;
        blanks.push(line.from);
      }
      if (blanks.length > 1) for (const start of blanks) {
        ranges.push(Decoration.line({ class: "live-preview-blank-list-line" }).range(start));
      }
    }
    const soleImage = block.firstChild;
    const soleImageUrl = soleImage?.name === "Image" ? soleImage.getChild("URL") : null;
    const stableImage = soleImage?.from === from && soleImage.to === to && soleImageUrl
      && isBase64ImageUrl(source.slice(soleImageUrl.from, soleImageUrl.to));
    if ((!active || block.name === "Table" || stableImage) && block.name !== "LinkReference") {
      ranges.push(Decoration.replace({ block: true, widget: new PreviewBlock(source.slice(from, to), from,
        stableImage ? "Base64Image" : block.name, mount, Boolean(stableImage && selected(from, to)), references) }).range(from, to));
      continue;
    }

    for (let index = source.indexOf("\n", from); index >= 0 && index < to; index = source.indexOf("\n", index + 1)) {
      let part: SyntaxNode | null = tree.resolveInner(index, 1);
      while (part && part.name !== "Paragraph" && part.name !== "HardBreak") part = part.parent;
      if (part?.name !== "Paragraph") continue;
      let end = index + 1;
      while (end < part.to && (/[ \t]/.test(source[end])
        || source[end] === ">" && tree.resolveInner(end, 1).name === "QuoteMark")) end++;
      if (end < part.to) ranges.push(Decoration.replace({ widget: softBreak }).range(index, end));
    }

    const heading = /^ATXHeading([1-6])$/.exec(block.name);
    const blockClass = heading && !bareHeading ? `live-preview-heading-${heading[1]}`
      : block.name === "FencedCode" || block.name === "CodeBlock" ? "live-preview-code-block"
      : block.name === "Blockquote" ? "live-preview-quote"
      : block.name === "BulletList" || block.name === "OrderedList" ? "live-preview-list" : "";
    if (blockClass) {
      const lastLine = state.doc.lineAt(to - 1).number;
      for (let number = state.doc.lineAt(from).number; number <= lastLine; number++) {
        const line = state.doc.line(number);
        const blankListLine = (block.name === "BulletList" || block.name === "OrderedList")
          && !line.text.trim() && number < lastLine
          && /^\s*(?:[-+*]|\d+[.)])\s/.test(state.doc.line(number + 1).text);
        ranges.push(Decoration.line({ class: blankListLine
          ? `${blockClass} live-preview-blank-list-line` : blockClass }).range(line.from));
      }
    }

    const inner = block.cursor();
    let hiddenImageTo = -1;
    do {
      const node = inner.node;
      if (node.from < hiddenImageTo && node.to <= hiddenImageTo) continue;
      if (node.name === "Image") {
        const url = node.getChild("URL");
        if (url && isBase64ImageUrl(source.slice(url.from, url.to))) {
          ranges.push(Decoration.replace({ widget: new PreviewImage(source.slice(node.from, node.to), node.from,
            selected(node.from, node.to)) }).range(node.from, node.to));
          hiddenImageTo = node.to;
          continue;
        }
      }
      if (["HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "ListMark", "QuoteMark", "TaskMarker"].includes(node.name)) {
        mark(node.from, node.to, "live-preview-mark");
      } else if (node.name === "StrongEmphasis" || node.name === "Emphasis" || node.name === "InlineCode") {
        const delimiter = node.name === "InlineCode" ? "CodeMark" : "EmphasisMark";
        const marks = node.getChildren(delimiter);
        if (marks.length >= 2) mark(marks[0].to, marks.at(-1)!.from,
          node.name === "StrongEmphasis" ? "live-preview-strong"
            : node.name === "Emphasis" ? "live-preview-emphasis" : "live-preview-code");
      } else if (node.name === "Link") {
        const marks = node.getChildren("LinkMark");
        if (marks.length >= 2) mark(marks[0].to, marks[1].from, "live-preview-link");
      }
    } while (inner.next());
  } while (cursor.nextSibling());

  for (const number of new Set([...afterHeading, ...beforeHeading])) {
    if (number < 1 || number > state.doc.lines) continue;
    const line = state.doc.line(number);
    if (line.text.trim()) continue;
    ranges.push(Decoration.line({ class: beforeHeading.has(number)
      ? "live-preview-before-heading" : "live-preview-after-heading" }).range(line.from));
  }

  return Decoration.set(ranges, true);
}

const focusEffect = StateEffect.define<boolean>();
const previewField = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create: (state) => ({ focused: false, decorations: decorate(state, false) }),
  update: (value, transaction) => {
    const focus = transaction.effects.find((effect) => effect.is(focusEffect));
    const focused = focus ? focus.value : value.focused;
    return transaction.docChanged || transaction.reconfigured || focused !== value.focused
      || !transaction.startState.selection.eq(transaction.state.selection)
      ? { focused, decorations: decorate(transaction.state, focused) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function enterPreviewBlock(view: EditorView, forward: boolean) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const next = view.moveVertically(selection, forward);
  if (next.head === selection.head) return false;
  let target: number | undefined;
  let tableFrom: number | undefined;
  view.state.field(previewField).decorations.between(
    Math.min(selection.head, next.head), Math.max(selection.head, next.head),
    (from, to, decoration) => {
      if (decoration.spec.block !== true) return;
      if (forward && from > selection.head && from <= next.head && (target === undefined || from < target)) {
        target = from;
        tableFrom = decoration.spec.widget?.kind === "Table" ? from : undefined;
      }
      if (!forward && to < selection.head && to >= next.head && (target === undefined || to > target)) {
        target = to;
        tableFrom = decoration.spec.widget?.kind === "Table" ? from : undefined;
      }
    },
  );
  if (target === undefined) return false;
  if (tableFrom !== undefined) {
    const cells = view.dom.querySelectorAll<HTMLElement>(`.live-preview-block[data-preview-from="${tableFrom}"] th[contenteditable], .live-preview-block[data-preview-from="${tableFrom}"] td[contenteditable]`);
    const cell = forward ? cells[0] : cells[cells.length - 1];
    if (cell) { cell.focus(); return true; }
  }
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}

export const livePreview = [
  previewField,
  EditorView.atomicRanges.of((view) => {
    const images: Range<Decoration>[] = [];
    view.state.field(previewField).decorations.between(0, view.state.doc.length, (from, to, decoration) => {
      const widget = decoration.spec.widget;
      if (widget instanceof PreviewImage || widget instanceof PreviewBlock && widget.kind === "Base64Image") {
        images.push(decoration.range(from, to));
      }
    });
    return Decoration.set(images);
  }),
  EditorView.focusChangeEffect.of((_state, focused) => focusEffect.of(focused)),
  EditorView.updateListener.of(({ view }) => {
    // A hidden editor can keep DOM focus while its preview state is recreated.
    if (view.state.field(previewField).focused === view.hasFocus) return;
    queueMicrotask(() => {
      if (view.dom.isConnected && view.state.field(previewField).focused !== view.hasFocus)
        view.dispatch({ effects: focusEffect.of(view.hasFocus) });
    });
  }),
  Prec.highest(keymap.of([
    { key: "ArrowDown", run: (view) => enterPreviewBlock(view, true) },
    { key: "ArrowUp", run: (view) => enterPreviewBlock(view, false) },
  ])),
];
