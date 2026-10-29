import { markdownLanguage } from "@codemirror/lang-markdown";
import { decodeString } from "micromark-util-decode-string";
type Cell = { from: number; to: number };
type SyntaxNode = ReturnType<typeof markdownLanguage.parser.parse>["topNode"];

export function sourceCharacters(content: string, cell: Cell): { text: string; spans: Cell[] } {
  const tree = markdownLanguage.parser.parse(content);
  const node = tree.resolveInner(cell.from, 1);
  const spans: Cell[] = [];
  let text = "";
  const plain = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      text += content[index];
      spans.push({ from: index, to: index + 1 });
    }
  };
  const visit = (part: SyntaxNode) => {
    if (part.name === "Image" || part.name === "LinkTitle" || part.name === "HardBreak"
      || part.name === "CodeInfo" || part.name === "TaskMarker"
      || part.name === "URL" && part.parent?.name !== "Autolink"
      || part.name.endsWith("Mark")) return;
    if (part.name === "Escape" || part.name === "Entity") {
      for (const character of decodeString(content.slice(part.from, part.to))) {
        text += character;
        for (let index = 0; index < character.length; index++) spans.push({ from: part.from, to: part.to });
      }
      return;
    }
    let position = Math.max(cell.from, part.from);
    for (let child = part.firstChild; child; child = child.nextSibling) {
      if (child.to <= cell.from || child.from >= cell.to) continue;
      plain(position, Math.min(child.from, cell.to));
      visit(child);
      position = Math.min(child.to, cell.to);
    }
    plain(position, Math.min(part.to, cell.to));
  };
  visit(node.from === cell.from && node.to === cell.to ? node : tree.topNode);
  return { text, spans };
}
