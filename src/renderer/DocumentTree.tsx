import { useEffect, useState } from 'react';
import type { ItemSummary } from '../shared/project-items';

export function DocumentTree({ items, selectedId, dirtyIds, onSelect }: { items: ItemSummary[]; selectedId: string | null; dirtyIds: Set<string>; onSelect(id: string): void }) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const modified = (item: ItemSummary) => Date.parse(item.fileModifiedAt ?? item.updatedAt) || 0;
  useEffect(() => {
    const path = items.find(item => item.id === selectedId)?.path;
    if (path) setCollapsed(current => new Set([...current].filter(folder => !path.startsWith(`${folder}/`))));
  }, [selectedId, items]);
  function rows(prefix = ''): React.ReactNode {
    const children = items.filter(item => (item.path ?? item.title).startsWith(prefix));
    const folders = [...new Set(children.map(item => (item.path ?? item.title).slice(prefix.length)).filter(path => path.includes('/')).map(path => path.split('/')[0]))].sort();
    return <ul>{folders.map(folder => {
      const path = `${prefix}${folder}`, open = !collapsed.has(path);
      return <li key={path}><button type="button" className="document-folder" title={path} aria-expanded={open} aria-label={`${open ? '折叠' : '展开'} ${path}`} onClick={() => setCollapsed(current => { const next = new Set(current); open ? next.add(path) : next.delete(path); return next; })}>{open ? '▾' : '▸'} <span>{folder}</span></button>{open && rows(`${path}/`)}</li>;
    })}{children.filter(item => !(item.path ?? item.title).slice(prefix.length).includes('/')).sort((a, b) => modified(b) - modified(a) || (a.path ?? a.title).localeCompare(b.path ?? b.title)).map(item => <li key={item.id}><button type="button" className={`document-file${selectedId === item.id ? ' is-selected' : ''}`} aria-current={selectedId === item.id ? 'page' : undefined} title={item.path ?? item.title} onClick={() => onSelect(item.id)}><span>{item.title}{dirtyIds.has(item.id) && ' · 草稿'}{item.deletedAt ? ' · 已删除' : item.archived ? ' · 已归档' : ''}</span><small>{(item.path ?? item.title).slice(prefix.length)}</small></button></li>)}</ul>;
  }
  return <nav className="document-tree" aria-label="文档文件树">{rows()}</nav>;
}
