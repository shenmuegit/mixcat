import { createElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isMediaDataUrl, markdownUrlTransform } from './markdown-url';

export interface MarkdownSourceHooks {
  onOpenLink?(href: string): void;
  renderLink?(href: string, children: ReactNode): ReactNode;
  resolveResource?(href: string): Promise<string>;
}

function Resource({ href, alt, title, resolveResource }: { href: string; alt?: string; title?: string; resolveResource?: MarkdownSourceHooks['resolveResource'] }) {
  const [resource, setResource] = useState<{ href: string; url?: string; error?: string }>({ href });
  useEffect(() => {
    let current = true;
    setResource({ href });
    const resolve = resolveResource ? resolveResource(href) : /^https?:\/\//i.test(href) || isMediaDataUrl(href) ? Promise.resolve(href) : Promise.reject(new Error('当前来源无法读取此资源。'));
    void resolve.then(url => {
      if (!/^https?:\/\//i.test(url) && !isMediaDataUrl(url)) throw new Error('媒体地址不受支持。');
      if (current) setResource({ href, url });
    }).catch(error => { if (current) setResource({ href, error: String(error.message ?? error) }); });
    return () => { current = false; };
  }, [href, resolveResource]);
  if (resource.href !== href || !resource.url) return <span className="document-resource-status" role={resource.error ? 'alert' : 'status'}>{resource.error ? `${alt || '资源'}：${resource.error}` : `正在载入${alt || '资源'}…`}</span>;
  const url = resource.url;
  const path = href.split(/[?#]/)[0];
  if (/^data:audio\//i.test(url) || /\.(mp3|wav|ogg|m4a)$/i.test(path)) return <audio className="document-media" src={url} controls preload="metadata" aria-label={alt || '音频'} />;
  if (/^data:video\//i.test(url) || /\.(mp4|webm)$/i.test(path)) return <video className="document-media" src={url} controls preload="metadata" aria-label={alt || '视频'} />;
  return <img src={url} alt={alt ?? ''} title={title} loading="lazy" decoding="async" />;
}

export function SharedMarkdown({ content, headingPrefix, headingOffset = 0, onOpenLink, renderLink, resolveResource }: MarkdownSourceHooks & { content: string; headingPrefix?: string; headingOffset?: number }) {
  const [error, setError] = useState('');
  let headingIndex = headingOffset;
  const components: Components = {
    img: ({ src, alt, title }) => <Resource href={typeof src === 'string' ? src : ''} alt={alt} title={title} resolveResource={resolveResource} />,
    a: ({ href = '', children }) => {
      if (!href) return <span>{children}</span>;
      if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noreferrer" onClick={event => {
        if (window.mixcat?.openExternal) { event.preventDefault(); void window.mixcat.openExternal(href).catch(error => setError(String(error))); }
      }}>{children}</a>;
      if (renderLink) return renderLink(href, children);
      return onOpenLink ? <button type="button" className="item-reference" onClick={() => onOpenLink(href)}>{children}</button> : <span className="unresolved-reference">{children}</span>;
    },
    pre: ({ children }) => <pre className="markdown-raw">{children}</pre>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  };
  for (const level of [1, 2, 3, 4, 5, 6] as const) components[`h${level}`] = ({ children }) => createElement(`h${level}`, { id: headingPrefix ? `${headingPrefix}-${headingIndex++}` : undefined, tabIndex: headingPrefix ? -1 : undefined }, children);
  return <div className="project-markdown markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform} components={components}>{content}</ReactMarkdown>{error && <p role="alert" className="inline-error">{error}</p>}</div>;
}
