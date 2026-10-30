import type { ReactNode } from 'react';
import { MarkdownDocument, type MarkdownDocumentProps } from './MarkdownDocument';

export interface DocumentEditorPaneProps extends MarkdownDocumentProps {
  title: string;
  onTitleChange(title: string): void;
  titleLabel?: string;
  children?: ReactNode;
}

export function DocumentEditorPane({ title, onTitleChange, titleLabel = '工作项标题', children, ...body }: DocumentEditorPaneProps) {
  return <article className={`document-canvas shared-document${body.editing ? ' document-editing' : ' document-reading'}`} data-content-identity={body.identity} aria-label={body.editing ? '文档编辑' : '文档阅读'}>
    <header>{body.editing ? <textarea className="document-title" aria-label={titleLabel} placeholder="标题" rows={1} required maxLength={200} disabled={body.disabled} value={title} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} onChange={event => onTitleChange(event.target.value.replace(/[\r\n]/g, ' '))} /> : <h1 className="document-title">{title}</h1>}</header>
    <MarkdownDocument key={body.identity} {...body} />
    {children}
  </article>;
}
