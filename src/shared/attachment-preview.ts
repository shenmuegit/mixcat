const attachmentTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'video/webm'
};

export function attachmentPreviewMime(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return extension && Object.hasOwn(attachmentTypes, extension) ? attachmentTypes[extension] : undefined;
}

export interface AttachmentPreview {
  mime: string;
  url: string;
}
