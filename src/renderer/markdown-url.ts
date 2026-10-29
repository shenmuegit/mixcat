import type { UrlTransform } from 'react-markdown';

export const isBase64ImageUrl = (url: string) => /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url);
export const isMediaDataUrl = (url: string) => /^data:(?:image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg|mp4)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/]+={0,2}$/i.test(url);

export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (/^[\u0000-\u0020]|[\u0000-\u001f\u007f]/.test(url) || url.startsWith('//') || url.startsWith('\\')) return '';
  if (node.tagName === 'img' && key === 'src') return isMediaDataUrl(url) || /^https?:\/\//i.test(url) || /^mixcat-asset:[a-f0-9]{64}\.[a-z0-9]+$/.test(url) || !/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith('/') ? url : '';
  return /^(?:https?:\/\/|mixcat:\/\/|mixcat-note:\/\/|note:|#)/i.test(url) || !/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith('/') ? url : '';
};
