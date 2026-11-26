import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { itemNumber, type ItemSummary } from '../shared/project-items';
import type { ProjectSnapshot, ProjectSummary } from '../shared/types';
import type { ProjectJump } from './ProjectManagement';
import { Icon } from './Icon';

type Destination = { kind: 'project'; id: string } | ProjectJump;
interface Match { target: Destination; title: string; type: string; context: string; icon: 'folder' | 'nodes' | 'note' | 'feed' }

export function CommandPalette({ projects, project, onClose, onOpen }: {
  projects: ProjectSummary[]; project: ProjectSnapshot | null; onClose(): void; onOpen(target: Destination): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [value, setValue] = useState(''), [composing, setComposing] = useState(false), [index, setIndex] = useState(0);
  const [read, setRead] = useState<{ key: string; items: ItemSummary[]; error: string }>();
  const [retry, setRetry] = useState(0);
  const query = value.trim(), projectId = project?.project.id;
  const key = projectId && query ? JSON.stringify([projectId, project?.managementRevision, query, retry]) : '';
  const current = read?.key === key ? read : undefined;
  const normalized = query.toLocaleLowerCase();
  const matches: Match[] = [
    ...projects.filter(item => !item.unavailable && (item.name + ' ' + item.root).toLocaleLowerCase().includes(normalized)).map(item => ({
      target: { kind: 'project', id: item.id } as const, title: item.name, type: '项目', context: item.root, icon: 'folder' as const,
    })),
    ...(project?.nodes ?? []).filter(node => node.name.toLocaleLowerCase().includes(normalized)).map(node => ({
      target: { kind: 'node', projectId: projectId!, id: node.id } as const, title: node.name, type: '节点', context: project!.project.name, icon: 'nodes' as const,
    })),
    ...(current?.items ?? []).map(item => ({
      target: { kind: item.kind, projectId: projectId!, id: item.id }, title: item.title, type: item.kind === 'document' ? '文档' : 'Issue',
      context: project!.project.name + ' · ' + (item.path ?? itemNumber(item)), icon: item.kind === 'document' ? 'note' as const : 'feed' as const,
    })),
  ];
  const active = Math.min(index, matches.length - 1);
  const optionId = (position: number) => listId + '-option-' + position;

  useLayoutEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!key || !projectId || composing) return;
    let live = true;
    const timer = setTimeout(() => {
      Promise.all((['issue', 'document'] as const).map(kind => window.mixcat.command({
        id: crypto.randomUUID(), command: { type: 'search_project_items', projectId, query: { kind, text: query, limit: 12 } },
      }))).then(replies => {
        if (!live) return;
        if (replies.some(reply => !reply.projectItems)) throw new Error('项目未返回匹配结果。');
        setRead({ key, items: replies.flatMap(reply => reply.projectItems!.items), error: '' });
      }).catch(error => { if (live) setRead({ key, items: [], error: error instanceof Error ? error.message : String(error) }); });
    }, 140);
    return () => { live = false; clearTimeout(timer); };
  }, [projectId, query, key, composing]);
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, current]);

  function dismiss() { dialog.current?.close(); onClose(); }
  function choose(target: Destination) { dismiss(); onOpen(target); }
  function change(next: string) { setValue(next); setIndex(0); }
  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!matches.length) return;
      event.preventDefault();
      setIndex((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(matches[active].target); }
  }

  return <dialog ref={dialog} className="modal command-palette" aria-label="命令面板"
    onCancel={event => { event.preventDefault(); if (!composing) dismiss(); }}>
    <div className="command-palette-search">
      <Icon name="search" size={18} />
      <input ref={input} value={value} placeholder={project ? '搜索项目、节点、Issue 或文档' : '搜索项目'} aria-label="搜索命令"
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        onChange={event => change(event.target.value)} onKeyDown={handleKeys}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); change(event.currentTarget.value); }} />
      {value && <button type="button" className="text-button command-palette-clear" onClick={() => { change(''); input.current?.focus(); }}>清除</button>}
      <button type="button" className="icon-button" aria-label="关闭命令面板" onClick={dismiss}><Icon name="close" size={16} /></button>
    </div>
    <div className="command-palette-content">
      <div id={listId} className="command-palette-results" role="listbox" aria-label="匹配结果">
        {matches.map(({ target, title, type, context, icon }, position) => <button
          key={target.kind + ':' + target.id} id={optionId(position)} type="button" role="option" tabIndex={-1} aria-selected={position === active}
          onClick={() => choose(target)}>
          <Icon name={icon} size={16} />
          <span className="command-palette-result" title={title + ' · ' + context}><strong>{title}</strong><small>{context}</small></span>
          <span className="command-palette-type">{type}</span>
        </button>)}
      </div>
      {key && !composing && !current && <p role="status">正在查找…</p>}
      {current?.error && <p role="alert" className="inline-error">查找失败。{current.error}<button type="button" className="text-button" onClick={() => { setRetry(value => value + 1); input.current?.focus(); }}>重试</button></p>}
      {!matches.length && (!key || current) && !current?.error && <p role="status">{query ? '没有匹配的结果' : '暂无可打开的项目'}</p>}
    </div>
    <footer className="command-palette-keys"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer>
  </dialog>;
}
