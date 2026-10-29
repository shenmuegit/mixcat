import { createContext, createElement, Fragment, useContext, useState, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { itemNumber, parseItemReference, type ItemReference, type ItemSummary } from '../shared/project-items';

export const itemKinds = { todo: 'Issue', issue: 'Issue', document: '文档' };
export const itemStatuses: Record<string, string> = { todo: '待处理', doing: '进行中', blocked: '阻塞', done: '已完成', open: '待处理', closed: '已关闭', canceled: '已取消', active: '文档' };
export const ReferenceNavigation = createContext<{ projectId: string; items: ItemSummary[]; open(reference: ItemReference, commentId?: string): void } | null>(null);
const decoded = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]!));

export function markdownHeadings(text: string, prefix: string) {
  const headings: { id: string; text: string; depth: number }[] = [];
  marked.walkTokens(marked.lexer(text), token => { if (token.type === 'heading') headings.push({ id: `${prefix}-${headings.length}`, text: decoded(token.text), depth: token.depth }); });
  return headings;
}

export function ProjectMarkdown({ text, historical = false, headingPrefix, tokens: suppliedTokens, headingOffset = 0 }: { text: string; historical?: boolean; headingPrefix?: string; tokens?: Token[]; headingOffset?: number }) {
  const navigation = useContext(ReferenceNavigation), [error, setError] = useState('');
  const tokens = suppliedTokens ?? marked.lexer(text), headingIds = new Map<Token, string>();
  if (headingPrefix) marked.walkTokens(tokens, token => { if (token.type === 'heading') headingIds.set(token, `${headingPrefix}-${headingOffset + headingIds.size}`); });
  function render(tokens: Token[]): ReactNode[] {
    return tokens.map((token, key) => {
      const children = 'tokens' in token && Array.isArray(token.tokens) ? render(token.tokens as Token[]) : 'text' in token ? decoded(String(token.text)) : '';
      switch (token.type) {
        case 'space': case 'def': return null;
        case 'heading': return createElement(`h${token.depth}`, { key, id: headingIds.get(token), tabIndex: headingPrefix ? -1 : undefined }, children);
        case 'paragraph': return <p key={key}>{children}</p>;
        case 'text': case 'escape': return <Fragment key={key}>{children}</Fragment>;
        case 'strong': return <strong key={key}>{children}</strong>;
        case 'em': return <em key={key}>{children}</em>;
        case 'del': return <del key={key}>{children}</del>;
        case 'code': return <pre key={key}><code>{token.text}</code></pre>;
        case 'codespan': return <code key={key}>{decoded(token.text)}</code>;
        case 'html': return <pre key={key} className="markdown-raw">{token.text}</pre>;
        case 'br': return <br key={key} />;
        case 'hr': return <hr key={key} />;
        case 'blockquote': return <blockquote key={key}>{render(token.tokens ?? [])}</blockquote>;
        case 'list': {
          const list = token.items.map((item: Tokens.ListItem, index: number) => <li key={index}>{item.task && <input type="checkbox" checked={item.checked} disabled aria-label={item.text} />}{render(item.tokens)}</li>);
          return token.ordered ? <ol key={key} start={Number(token.start) || 1}>{list}</ol> : <ul key={key}>{list}</ul>;
        }
        case 'table': return <div className="markdown-table" key={key}><table><thead><tr>{token.header.map((cell: any, index: number) => <th key={index}>{render(cell.tokens)}</th>)}</tr></thead><tbody>{token.rows.map((row: any[], index: number) => <tr key={index}>{row.map((cell: any, column: number) => <td key={column}>{render(cell.tokens)}</td>)}</tr>)}</tbody></table></div>;
        case 'link': {
          const reference = parseItemReference(token.href);
          if (reference) {
            const target = navigation?.items.find(item => item.id === reference.id && item.kind === reference.kind);
            const label = target && !historical ? `@${itemNumber(target)} ${target.title}` : children;
            const title = target ? `${itemKinds[target.kind]} · ${target.deletedAt ? '已删除' : target.archived ? '已归档' : itemStatuses[target.status]}` : '查看引用；目标可能尚未加载或已缺失';
            return navigation?.projectId === reference.projectId
              ? <button key={key} type="button" className="item-reference" title={title} onClick={() => navigation.open(reference)}>{label}{target?.deletedAt ? '（已删除）' : target?.archived ? '（归档）' : ''}</button>
              : <span key={key} className="unresolved-reference" title="该引用属于其他项目或当前环境无法打开">{children}</span>;
          }
          if (/^https?:\/\//i.test(token.href)) return <a key={key} href={token.href} target="_blank" rel="noreferrer" onClick={event => {
            if (window.mixcat?.openExternal) { event.preventDefault(); void window.mixcat.openExternal(token.href).catch(error => setError(String(error))); }
          }}>{children}</a>;
          return <span key={key} title="此链接不能在预览中打开">{children}</span>;
        }
        case 'image': return <span key={key} className="markdown-image" title={token.href}>图片：{token.text || token.href}</span>;
        default: return <span key={key}>{'raw' in token ? String(token.raw) : ''}</span>;
      }
    });
  }
  return <div className="project-markdown">{render(tokens)}{error && <p role="alert" className="inline-error">{error}</p>}</div>;
}
