// Adapted from BoardUI Tree View, ec5c5eb3e29c2441be63b9422cd54f411ef23466.
// https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/tree-view/tree-view.tsx
// The original MIT notice ships with the renderer at licenses/BoardUI.txt.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, Collection, I18nProvider, Tree, TreeItem, TreeItemContent, type Key } from 'react-aria-components';
import { documentFileTitle, type ItemSummary } from '../shared/project-items';
import { Icon } from './Icon';

type FolderRow = { kind: 'folder'; id: string; path: string; name: string; children: DocumentRow[] };
type FileRow = { kind: 'file'; id: string; path: string; name: string; item: ItemSummary };
type DocumentRow = FolderRow | FileRow;

const modified = (item: ItemSummary) => Date.parse(item.fileModifiedAt ?? item.updatedAt) || 0;

function buildRows(items: ItemSummary[]) {
  const rows: DocumentRow[] = [];
  const folders = new Map<Key, FolderRow>();
  const files = new Map<Key, ItemSummary>();
  let maxDepth = 0;
  for (const item of items) {
    if (item.deletedAt) continue;
    const path = item.path ?? item.title;
    const segments = path.split('/');
    const name = segments.pop()!;
    let prefix = segments[0]?.toLowerCase() === 'docs' ? `${segments.shift()}/` : '';
    maxDepth = Math.max(maxDepth, segments.length);
    let children = rows;
    for (const segment of segments) {
      const folderPath = prefix + segment;
      const key = `folder:${folderPath}`;
      let folder = folders.get(key);
      if (!folder) {
        folder = { kind: 'folder', id: key, path: folderPath, name: segment, children: [] };
        children.push(folder);
        folders.set(key, folder);
      }
      children = folder.children;
      prefix = folderPath + '/';
    }
    const id = `file:${item.id}`;
    children.push({ kind: 'file', id, path, name, item });
    files.set(id, item);
  }
  function sort(branch: DocumentRow[]) {
    branch.sort((left, right) => {
      if (left.kind === 'folder' && right.kind === 'folder') {
        if (left.name === right.name) return 0;
        return left.name < right.name ? -1 : 1;
      }
      if (left.kind === 'file' && right.kind === 'file') return modified(right.item) - modified(left.item) || left.path.localeCompare(right.path);
      return left.kind === 'folder' ? -1 : 1;
    });
    for (const row of branch) if (row.kind === 'folder') sort(row.children);
  }
  sort(rows);
  return { rows, folders, files, maxDepth };
}

export function DocumentTree({ items, selectedId, dirtyIds, onSelect, onDelete, focusFolder }: {
  items: ItemSummary[];
  selectedId: string | null;
  dirtyIds: Set<string>;
  onSelect(id: string): void;
  onDelete?(id: string): void;
  focusFolder?: { path: string | null };
}) {
  const { rows, folders, files, maxDepth } = useMemo(() => buildRows(items), [items]);
  const [collapsed, setCollapsed] = useState(new Set<Key>());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLElement>(null);
  const tree = useRef<HTMLDivElement>(null), lastFocus = useRef<typeof focusFolder>(undefined);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); menuTrigger.current?.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  useEffect(() => {
    const selected = selectedId === null ? undefined : files.get(`file:${selectedId}`);
    if (!selected) return;
    const selectedPath = `folder:${selected.path ?? selected.title}`;
    setCollapsed(current => {
      const open = [...current].filter(key => !selectedPath.startsWith(`${key}/`));
      return open.length === current.size ? current : new Set(open);
    });
  }, [selectedId, files]);

  const expandedKeys = new Set([...folders.keys()].filter(key => !collapsed.has(key)));
  useLayoutEffect(() => {
    if (!focusFolder || focusFolder === lastFocus.current) return;
    const key = focusFolder.path === null ? null : `folder:${focusFolder.path}`;
    if (key && !folders.has(key)) return;
    const closed = key ? [...collapsed].filter(folder => folder === key || key.startsWith(`${folder}/`)) : [];
    if (closed.length) {
      setCollapsed(current => new Set([...current].filter(folder => !closed.includes(folder))));
      return;
    }
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[data-document-key]') ?? [])];
    const row = key ? rows.find(item => item.dataset.documentKey === key) : rows[0];
    if (!row) return;
    lastFocus.current = focusFolder;
    row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' });
  }, [focusFolder, folders, collapsed]);
  function changeExpansion(expanded: Set<Key>) {
    setCollapsed(current => {
      const next = new Set(current);
      for (const key of folders.keys()) {
        if (expanded.has(key)) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  function activate(key: Key) {
    const file = files.get(key);
    if (file) {
      onSelect(file.id);
      return;
    }
    if (folders.has(key)) {
      setCollapsed(current => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    }
  }

  function openMenu(row: HTMLElement, x: number, y: number) {
    const file = files.get(row.dataset.documentKey ?? '');
    if (!onDelete || !file || file.archived || file.deletedAt) return false;
    menuTrigger.current = row;
    setMenu({ id: file.id, x: Math.max(8, Math.min(x, window.innerWidth - 188)), y: Math.max(8, Math.min(y, window.innerHeight - 60)) });
    return true;
  }

  function handleTreeKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const row = event.target;
    if (!(row instanceof HTMLElement) || row.getAttribute('role') !== 'row') return;
    const key = row.dataset.documentKey;
    if (!key) return;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      const rect = row.getBoundingClientRect();
      if (openMenu(row, rect.left + 12, rect.bottom)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.shiftKey) return;

    // Preserve Space activation from the old native file and folder buttons.
    if (event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) activate(key);
      return;
    }

    // React Aria handles closed folders and parent navigation. Forward from
    // an already-expanded folder to its first child in the rendered collection.
    if (event.key !== 'ArrowRight' || row.getAttribute('aria-expanded') !== 'true') return;
    const firstChild = folders.get(key)?.children[0];
    const nextRow = row.nextElementSibling;
    if (!firstChild || !(nextRow instanceof HTMLElement) || nextRow.dataset.documentKey !== firstChild.id) return;
    event.preventDefault();
    event.stopPropagation();
    nextRow.focus();
  }

  function renderRow(row: DocumentRow) {
    const folder = row.kind === 'folder';
    const selected = row.kind === 'file' && row.item.id === selectedId;
    const label = row.kind === 'file'
      ? row.item.title + (dirtyIds.has(row.item.id) ? ' · 未保存' : '') + (row.item.archived ? ' · 已归档' : '')
      : row.name;
    return <TreeItem
      id={row.id}
      textValue={label}
      data-document-key={row.id}
      data-document-path={row.path}
      className={folder ? 'document-folder' : `document-file${selected ? ' is-selected' : ''}`}
      style={({ level }) => {
        const depth = level - 1;
        // Compress deeper steps so every level stays distinct in a narrow pane.
        const indent = Math.min(depth, 4) * 12 + Math.max(0, depth - 4) * 24 / Math.max(12, maxDepth - 4);
        return { '--document-tree-indent': `${indent}px` } as CSSProperties;
      }}
    >
      <TreeItemContent>
        {({ isExpanded }) => <>
          {folder ? <Button slot="chevron" className="document-tree-chevron" aria-label={`${isExpanded ? '折叠' : '展开'} ${row.path}`}>
            <Icon name="chevron" size={14} />
          </Button> : <span className="document-tree-chevron" aria-hidden="true" />}
          <Icon name={folder ? 'folder' : 'note'} size={16} />
          {folder ? <span className="document-folder-name" title={row.path}>{label}</span> : <span className="document-file-label" title={row.path}>
            <span className="document-file-title" aria-current={selected ? 'page' : undefined}>{label}</span>
            {documentFileTitle(row.name) !== row.item.title && <small>{row.name}</small>}
          </span>}
        </>}
      </TreeItemContent>
      {row.kind === 'folder' && <Collection items={row.children}>{renderRow}</Collection>}
    </TreeItem>;
  }

  return <I18nProvider locale="zh-CN">
    <div ref={tree} onKeyDownCapture={handleTreeKeys} onContextMenu={event => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-document-key]') : null;
      if (row && openMenu(row, event.clientX, event.clientY)) event.preventDefault();
    }}>
      <Tree
        className="document-tree"
        aria-label="文档文件树"
        items={rows}
        selectionMode="none"
        expandedKeys={expandedKeys}
        onExpandedChange={changeExpansion}
        onAction={activate}
      >{renderRow}</Tree>
      {menu && <div className="canvas-context-menu" ref={menuRef} role="menu" aria-label="文档操作" style={{ left: menu.x, top: menu.y }}>
        <button type="button" role="menuitem" className="danger-button" onClick={() => {
          setMenu(null);
          menuTrigger.current?.focus({ preventScroll: true });
          onDelete?.(menu.id);
        }}>删除</button>
      </div>}
    </div>
  </I18nProvider>;
}
