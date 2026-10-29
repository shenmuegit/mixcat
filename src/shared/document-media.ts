export type DocumentSource = { kind: 'notes' } | { kind: 'project'; projectId: string; path: string };
export type DocumentMediaCommand =
  | { operation: 'import'; source: DocumentSource; name: string; mime: string; base64: string }
  | { operation: 'read'; source: DocumentSource; href: string };
export interface DocumentMediaReply { href?: string; url?: string; }
