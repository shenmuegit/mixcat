import type { ArtifactRef, ProviderProfile } from '../shared/comfy.js';
import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

// Main-only: consume this inside ProviderSettingsService.withCredential, never over IPC.
export interface AuthorizedConnection { profile: ProviderProfile; key: string; }
export interface TextInput { model?: string; messages: { role: 'system' | 'user' | 'assistant'; content: string }[]; temperature?: number; maxTokens?: number; }
export interface ImageInput { model?: string; prompt: string; references?: ArtifactRef[]; size?: string; aspectRatio?: string; n?: number; seed?: number; }
// Private resumable sources: Task6 persists these before materializing; never send over graph/MCP/IPC.
export type MediaSource = { kind: 'image' | 'video' } & ({ url: string; base64?: never } | { base64: string; url?: never });
export interface MediaResponse { sources: MediaSource[]; failures: ProviderFailure[]; }
export type VideoInput = { model?: string; prompt: string; duration?: number; resolution?: string; aspectRatio?: string; seed?: number } & (
  | { mode: 'text'; images?: never }
  | { mode: 'image'; images: [ArtifactRef] }
  | { mode: 'reference'; images: ArtifactRef[] }
);
export interface RemoteTask { protocol: 'ark-video' | 'minimax-video-v1' | 'minimax-video-v2' | 'vidu-video'; id: string; }
export interface RemoteTaskState {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown'; rawStatus: string;
  sources?: MediaSource[]; error?: ProviderFailure;
}
export interface CancelOutcome { outcome: 'cancelled' | 'not_cancellable' | 'record_deleted' | 'unknown'; state?: RemoteTaskState; error?: ProviderFailure; }
export type ProviderOutcome = 'not_submitted' | 'rejected' | 'submission_unknown' | 'remote_task_retained' | 'output_source_retained' | 'operation_unknown';
export interface ProviderFailure {
  code: 'invalid_input' | 'http_error' | 'vendor_error' | 'malformed_response' | 'timeout' | 'aborted' | 'network_error' | 'download_failed' | 'media_too_large';
  message: string; outcome: ProviderOutcome; httpStatus?: number; vendorCode?: string; retryAfterSeconds?: number;
}
export class ProviderError extends Error {
  constructor(readonly detail: ProviderFailure) { super(detail.message); this.name = 'ProviderError'; }
  toJSON(): ProviderFailure { return this.detail; }
}
type Json = Record<string, any>;
function fail(code: ProviderFailure['code'], outcome: ProviderOutcome, extra: Partial<ProviderFailure> = {}): never {
  throw new ProviderError({ code, outcome, message: `Provider ${code.replaceAll('_', ' ')}.`, ...extra });
}
function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function token(value: unknown, key: string): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(text) && !text.includes(key) ? text : undefined;
}
function clean(text: string, key: string): string { return text.replaceAll(key, '[redacted]'); }
function required(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim()) fail('invalid_input', 'not_submitted'); }
const imageLimit = 64 * 1024 * 1024, videoLimit = 512 * 1024 * 1024;
function mediaType(bytes: Buffer): { mime: string; extension: string; kind: 'image' | 'video' } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png', kind: 'image' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg', kind: 'image' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp', kind: 'image' };
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { mime: 'image/gif', extension: 'gif', kind: 'image' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', extension: 'mp4', kind: 'video' };
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return { mime: 'video/webm', extension: 'webm', kind: 'video' };
}
function model(connection: AuthorizedConnection, kind: 'text' | 'image' | 'video', override?: string): string {
  const value = override === undefined ? connection.profile.models[kind] : override; required(value); return value;
}
function videoProtocol(connection: AuthorizedConnection): RemoteTask['protocol'] {
  if (connection.profile.protocol === 'ark') return 'ark-video';
  if (connection.profile.protocol === 'vidu') return 'vidu-video';
  return connection.profile.videoApi === 'v1' ? 'minimax-video-v1' : 'minimax-video-v2';
}
function checkTask(connection: AuthorizedConnection, task: RemoteTask): void {
  if (!task || typeof task.id !== 'string' || videoProtocol(connection) !== task.protocol || !token(task.id, connection.key)) fail('invalid_input', 'not_submitted');
}
const statuses: Record<RemoteTask['protocol'], Record<string, RemoteTaskState['status']>> = {
  'ark-video': { queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', expired: 'expired' },
  'minimax-video-v1': { Preparing: 'queued', Queueing: 'queued', Processing: 'running', Success: 'succeeded', Fail: 'failed' },
  'minimax-video-v2': { queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' },
  'vidu-video': { created: 'queued', queueing: 'queued', processing: 'running', success: 'succeeded', failed: 'failed' },
};
// Official model contracts checked 2026-10-30; unlisted IDs/Endpoint IDs stay verbatim for server validation.
const videoModels: Record<string, { protocol: RemoteTask['protocol']; modes: VideoInput['mode'][]; duration: [number, number]; resolutions: string[]; required?: boolean; references?: number }> = {
  'doubao-seedance-1-0-pro-250528': { protocol: 'ark-video', modes: ['text', 'image'], duration: [2, 12], resolutions: ['480p', '720p', '1080p'] },
  'doubao-seedance-1-0-pro-fast-251015': { protocol: 'ark-video', modes: ['text', 'image'], duration: [2, 12], resolutions: ['480p', '720p', '1080p'] },
  'doubao-seedance-2-0-260128': { protocol: 'ark-video', modes: ['text', 'image', 'reference'], duration: [4, 15], resolutions: ['480p', '720p', '1080p', '4k'], references: 9 },
  'doubao-seedance-2-0-fast-260128': { protocol: 'ark-video', modes: ['text', 'image', 'reference'], duration: [4, 15], resolutions: ['480p', '720p'], references: 9 },
  'doubao-seedance-2-0-mini-260615': { protocol: 'ark-video', modes: ['text', 'image', 'reference'], duration: [4, 15], resolutions: ['480p', '720p'], references: 9 },
  'doubao-seedance-2-5-260628': { protocol: 'ark-video', modes: ['text', 'image', 'reference'], duration: [4, 30], resolutions: ['480p', '720p', '1080p'], references: 30 },
  'MiniMax-H3': { protocol: 'minimax-video-v2', modes: ['text', 'image'], duration: [4, 15], resolutions: ['768P', '2K'], required: true },
  'MiniMax-H3-Highspeed': { protocol: 'minimax-video-v2', modes: ['text', 'image'], duration: [4, 15], resolutions: ['768P'], required: true },
  'MiniMax-H3-Lite': { protocol: 'minimax-video-v2', modes: ['text', 'image'], duration: [4, 15], resolutions: ['480P', '768P'], required: true },
  'MiniMax-H3-Max': { protocol: 'minimax-video-v2', modes: ['text', 'image'], duration: [5, 15], resolutions: ['480P', '768P'], required: true },
  'MiniMax-Hailuo-2.3': { protocol: 'minimax-video-v1', modes: ['text', 'image'], duration: [6, 10], resolutions: ['768P', '1080P'] },
  'MiniMax-Hailuo-2.3-Fast': { protocol: 'minimax-video-v1', modes: ['image'], duration: [6, 10], resolutions: ['768P', '1080P'] },
  'MiniMax-Hailuo-02': { protocol: 'minimax-video-v1', modes: ['text', 'image'], duration: [6, 10], resolutions: ['512P', '768P', '1080P'] },
  'viduq3-turbo': { protocol: 'vidu-video', modes: ['text', 'image', 'reference'], duration: [1, 16], resolutions: ['540p', '720p', '1080p'] },
  'viduq3-pro': { protocol: 'vidu-video', modes: ['text', 'image'], duration: [1, 16], resolutions: ['540p', '720p', '1080p'] },
  'viduq3-pro-fast': { protocol: 'vidu-video', modes: ['image'], duration: [1, 16], resolutions: ['540p', '720p', '1080p'] },
  'viduq3': { protocol: 'vidu-video', modes: ['reference'], duration: [3, 16], resolutions: ['540p', '720p', '1080p'] },
};
const imageModels: Record<string, { references: number; sizes: string[]; pixels: [number, number] }> = {
  'doubao-seedream-5-0-pro-260628': { references: 10, sizes: ['1K', '1.5K', '2K'], pixels: [921600, 4624220] },
  'doubao-seedream-5-0-flash-260915': { references: 10, sizes: ['1K', '1.5K', '2K'], pixels: [921600, 4624220] },
  'doubao-seedream-4-5-251128': { references: 14, sizes: ['2K', '4K'], pixels: [3686400, 16777216] },
  'doubao-seedream-4-0-250828': { references: 14, sizes: ['1K', '2K', '4K'], pixels: [921600, 16777216] },
};
function validateVideoModel(protocol: RemoteTask['protocol'], selectedModel: string, input: VideoInput): void {
  const known = Object.hasOwn(videoModels, selectedModel) ? videoModels[selectedModel] : undefined;
  if (!known) return;
  if (known.protocol !== protocol || !known.modes.includes(input.mode)
    || (known.required && (input.duration === undefined || input.resolution === undefined))
    || (input.duration !== undefined && (input.duration < known.duration[0] || input.duration > known.duration[1]))
    || (input.resolution !== undefined && !known.resolutions.includes(input.resolution))) fail('invalid_input', 'not_submitted');
  if (selectedModel === 'doubao-seedance-2-5-260628' && input.mode === 'image' && input.aspectRatio !== undefined && input.aspectRatio !== 'adaptive') fail('invalid_input', 'not_submitted');
  if (protocol === 'minimax-video-v2' && ((input.mode === 'text' && (!input.aspectRatio || input.aspectRatio === 'adaptive')) || (input.mode === 'image' && input.aspectRatio !== undefined && input.aspectRatio !== 'adaptive'))) fail('invalid_input', 'not_submitted');
  if ((protocol === 'minimax-video-v2' && input.prompt.length > 7000) || (protocol === 'minimax-video-v1' && input.prompt.length > 2000)) fail('invalid_input', 'not_submitted');
  if (protocol === 'minimax-video-v1' && ((input.duration !== undefined && ![6, 10].includes(input.duration)) || (input.duration === 10 && input.resolution === '1080P'))) fail('invalid_input', 'not_submitted');
  if (protocol === 'vidu-video') {
    if ((input.mode === 'reference' && input.duration !== undefined && input.duration < 3) || (input.mode === 'image' && input.aspectRatio !== undefined)
      || (input.aspectRatio !== undefined && !['16:9', '9:16', '1:1', '4:3', '3:4'].includes(input.aspectRatio))
      || input.prompt.length > (input.mode === 'reference' || (selectedModel === 'viduq3-turbo' && input.mode === 'text') ? 5000 : 20000)) fail('invalid_input', 'not_submitted');
  }
}
function endpoint(connection: AuthorizedConnection, prefix: string, path: string): string {
  let url: URL;
  try { url = new URL(connection.profile.baseUrl); } catch { return fail('invalid_input', 'not_submitted'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !connection.key || /[\r\n]/.test(connection.key)) fail('invalid_input', 'not_submitted');
  const base = url.pathname.replace(/\/+$/, '');
  if (/\/(?:v\d+)$/.test(base) && !base.endsWith(prefix)) fail('invalid_input', 'not_submitted');
  const [pathname, search] = path.split('?');
  url.pathname = `${base.endsWith(prefix) ? base : base + prefix}${pathname}`; url.search = search ?? '';
  return url.href;
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('body limit'); }
  const chunks: Buffer[] = []; let bytes = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > limit) throw new Error('body limit'); chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class ComfyProviders {
  readonly projectRoot: string;
  private readonly timeouts: { createMs: number; queryMs: number; downloadMs: number };
  constructor(projectRoot: string, timeouts: Partial<{ createMs: number; queryMs: number; downloadMs: number }> = {}) {
    this.projectRoot = ensureProjectDirectory(projectRoot);
    this.timeouts = { createMs: 120_000, queryMs: 30_000, downloadMs: 300_000, ...timeouts };
    for (const [name, max] of [['createMs', 120_000], ['queryMs', 30_000], ['downloadMs', 300_000]] as const) {
      const value = this.timeouts[name]; if (!Number.isInteger(value) || value < 1 || value > max) fail('invalid_input', 'not_submitted');
    }
  }
  private async request(connection: AuthorizedConnection, prefix: string, path: string, method: 'POST' | 'GET' | 'DELETE', body: Json | undefined,
    signal: AbortSignal | undefined, operation: 'create' | 'query' | 'cancel', limit = 2 * 1024 * 1024): Promise<Json> {
    const url = endpoint(connection, prefix, path);
    if (signal?.aborted) fail('aborted', operation === 'create' ? 'not_submitted' : operation === 'query' ? 'remote_task_retained' : 'operation_unknown');
    const timeout = AbortSignal.timeout(operation === 'create' ? this.timeouts.createMs : this.timeouts.queryMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const uncertain = operation === 'create' ? 'submission_unknown' : operation === 'query' ? 'remote_task_retained' : 'operation_unknown';
    try {
      const response = await fetch(url, { method, redirect: 'manual', signal: combined,
        headers: { Authorization: `${connection.profile.protocol === 'vidu' ? 'Token' : 'Bearer'} ${connection.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const retry = response.headers.get('retry-after');
      const retrySeconds = retry ? (/^\d+$/.test(retry) ? Number(retry) : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))) : undefined;
      const extra = { httpStatus: response.status, ...(Number.isFinite(retrySeconds) ? { retryAfterSeconds: Math.min(retrySeconds!, 86400) } : {}) };
      if (!response.ok) {
        let vendorCode: string | undefined;
        try {
          const errorBody = JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8'));
          if (object(errorBody)) vendorCode = token(errorBody.error?.code ?? errorBody.error?.type ?? errorBody.base_resp?.status_code ?? errorBody.code, connection.key);
        } catch { /* HTTP status remains authoritative when an error body cannot be decoded. */ }
        fail('http_error', operation === 'create' && response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : uncertain, { ...extra, ...(vendorCode ? { vendorCode } : {}) });
      }
      let data: unknown;
      try { data = JSON.parse((await boundedBody(response, limit)).toString('utf8')); }
      catch { if (combined.aborted) throw combined.reason; fail('malformed_response', uncertain, extra); }
      if (!object(data)) fail('malformed_response', uncertain, extra);
      const arkTaskFailure = operation === 'query' && connection.profile.protocol === 'ark' && data.status === 'failed' && typeof data.id === 'string';
      const vendorError = object(data.error) && !arkTaskFailure ? data.error : undefined;
      const base = object(data.base_resp) ? data.base_resp : undefined;
      if (vendorError || (base && base.status_code !== 0) || (data.code !== undefined && data.code !== 0)) {
        const vendorCode = token(vendorError?.code ?? vendorError?.type ?? base?.status_code ?? data.code, connection.key);
        const status = Number(vendorError?.http_code ?? data.code);
        const definiteRejection = (status >= 400 && status < 500 && status !== 408)
          || [1002, 1004, 1008, 1026, 2013].includes(base?.status_code)
          || /^(InvalidParameter|MissingParameter|AuthenticationError|Unauthorized|RateLimitExceeded)(\.|$)/.test(vendorCode ?? '');
        fail('vendor_error', operation === 'create' ? definiteRejection ? 'rejected' : 'submission_unknown' : operation === 'query' ? 'remote_task_retained' : 'operation_unknown', { ...extra, ...(vendorCode ? { vendorCode } : {}) });
      }
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail(signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network_error', uncertain);
    }
  }
  async generateText(connection: AuthorizedConnection, input: TextInput, signal?: AbortSignal): Promise<string> {
    if (connection.profile.protocol === 'vidu' || !Array.isArray(input.messages) || !input.messages.length) fail('invalid_input', 'not_submitted');
    for (const message of input.messages) { if (!['system', 'user', 'assistant'].includes(message.role)) fail('invalid_input', 'not_submitted'); required(message.content); }
    if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 1)) fail('invalid_input', 'not_submitted');
    if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) fail('invalid_input', 'not_submitted');
    const data = await this.request(connection, connection.profile.protocol === 'ark' ? '/api/v3' : '/v1', '/chat/completions', 'POST', {
      model: model(connection, 'text', input.model), messages: input.messages.map(({ role, content }) => ({ role, content })), stream: false,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}), ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    }, signal, 'create');
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') fail('malformed_response', 'submission_unknown');
    return clean(text, connection.key);
  }
  private async references(references: ArtifactRef[] | undefined, limit: number): Promise<string[]> {
    const images: string[] = [];
    if (references !== undefined && !Array.isArray(references)) fail('invalid_input', 'not_submitted');
    if ((references ?? []).reduce((bytes, reference) => bytes + (reference?.bytes ?? Infinity), 0) > 48 * 1024 * 1024) fail('invalid_input', 'not_submitted');
    for (const reference of references ?? []) {
      try {
        if (!reference || typeof reference.relativePath !== 'string' || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > limit) fail('invalid_input', 'not_submitted');
        const path = insideProject(this.projectRoot, join(this.projectRoot, reference.relativePath));
        const chunks: Buffer[] = []; let count = 0;
        for await (const chunk of createReadStream(path)) {
          count += chunk.length; if (count > reference.bytes || count > limit) fail('invalid_input', 'not_submitted'); chunks.push(Buffer.from(chunk));
        }
        if (count !== reference.bytes) fail('invalid_input', 'not_submitted');
        const bytes = Buffer.concat(chunks); const type = mediaType(bytes);
        if (!type || type.kind !== 'image' || type.mime !== reference.mime || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) fail('invalid_input', 'not_submitted');
        images.push(`data:${type.mime};base64,${bytes.toString('base64')}`);
      } catch { fail('invalid_input', 'not_submitted'); }
    }
    return images;
  }
  async generateImage(connection: AuthorizedConnection, input: ImageInput, signal?: AbortSignal): Promise<MediaResponse> {
    const ark = connection.profile.protocol === 'ark';
    if (connection.profile.protocol === 'vidu') fail('invalid_input', 'not_submitted');
    required(input.prompt);
    const selectedModel = model(connection, 'image', input.model), known = Object.hasOwn(imageModels, selectedModel) ? imageModels[selectedModel] : undefined;
    const n = input.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 9 || (ark && n !== 1) || (ark && input.aspectRatio !== undefined) || (!ark && input.size !== undefined)) fail('invalid_input', 'not_submitted');
    if (input.seed !== undefined && (ark || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647)) fail('invalid_input', 'not_submitted');
    if (input.size !== undefined && (typeof input.size !== 'string' || input.size.length > 32)) fail('invalid_input', 'not_submitted');
    if (known && input.size && !known.sizes.includes(input.size)) {
      const dimensions = /^(\d{1,5})x(\d{1,5})$/.exec(input.size), width = Number(dimensions?.[1]), height = Number(dimensions?.[2]);
      if (!dimensions || width * height < known.pixels[0] || width * height > known.pixels[1] || width / height < 1 / 16 || width / height > 16) fail('invalid_input', 'not_submitted');
    }
    if (!ark && input.aspectRatio !== undefined && !['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].includes(input.aspectRatio)) fail('invalid_input', 'not_submitted');
    if ((input.references?.length ?? 0) > (ark ? known?.references ?? 14 : 1)) fail('invalid_input', 'not_submitted');
    const images = await this.references(input.references, ark ? 30 * 1024 * 1024 : 20 * 1024 * 1024);
    const data = await this.request(connection, ark ? '/api/v3' : '/v1', ark ? '/images/generations' : '/image_generation', 'POST', {
      model: selectedModel, prompt: input.prompt,
      ...(ark ? { stream: false, ...(input.size ? { size: input.size } : {}), ...(images.length ? { image: images } : {}) }
        : { n, response_format: 'url', ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}), ...(images.length ? { subject_reference: [{ type: 'character', image_file: images[0] }] } : {}) }),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    }, signal, 'create', 96 * 1024 * 1024);
    const sources: MediaSource[] = [], failures: ProviderFailure[] = [];
    const malformed: ProviderFailure = { code: 'malformed_response', message: 'Provider image response item is malformed.', outcome: 'submission_unknown' };
    const addSource = (value: unknown, encoding: 'url' | 'base64') => {
      try {
        if (typeof value !== 'string') throw new Error();
        if (encoding === 'url') sources.push({ kind: 'image', url: this.mediaUrl(connection, value) });
        else {
          if (value.length > Math.ceil(imageLimit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error();
          const decoded = Buffer.from(value, 'base64');
          if (decoded.length > imageLimit || decoded.includes(Buffer.from(connection.key)) || mediaType(decoded)?.kind !== 'image') throw new Error();
          sources.push({ kind: 'image', base64: value });
        }
      } catch { failures.push({ ...malformed }); }
    };
    if (ark) {
      if (!Array.isArray(data.data) || !data.data.length) fail('malformed_response', 'submission_unknown');
      for (const item of data.data) {
        if (object(item) && object(item.error)) {
          failures.push({ code: 'vendor_error', message: 'Provider image item failed.', outcome: 'rejected', vendorCode: token(item.error.code, connection.key) });
        } else if (object(item) && typeof item.url === 'string') addSource(item.url, 'url');
        else if (object(item) && typeof item.b64_json === 'string') addSource(item.b64_json, 'base64');
        else failures.push({ ...malformed });
      }
    } else {
      if (!object(data.base_resp) || data.base_resp.status_code !== 0 || !object(data.data)) fail('malformed_response', 'submission_unknown');
      const urls = data.data.image_urls, base64 = data.data.image_base64;
      if (Array.isArray(urls)) for (const url of urls) addSource(url, 'url');
      else if (Array.isArray(base64)) for (const item of base64) addSource(item, 'base64');
      else fail('malformed_response', 'submission_unknown');
      const succeeded = Number(data.metadata?.success_count), failed = Number(data.metadata?.failed_count);
      if (!Number.isInteger(succeeded) || !Number.isInteger(failed) || succeeded !== sources.length || succeeded < 0 || failed < 0 || succeeded + failed !== n) {
        if (!sources.length) fail('malformed_response', 'submission_unknown'); failures.push({ ...malformed });
      } else for (let index = 0; index < failed; index++) failures.push({ code: 'vendor_error', message: 'Provider image item failed.', outcome: 'rejected' });
    }
    if (sources.length + failures.length === 0) fail('malformed_response', 'submission_unknown');
    return { sources, failures };
  }
  private mediaUrl(connection: AuthorizedConnection, value: unknown): string {
    let url: URL;
    try { if (typeof value !== 'string' || value.includes(connection.key) || decodeURIComponent(value).includes(connection.key)) throw new Error(); url = new URL(value); }
    catch { return fail('malformed_response', 'output_source_retained'); }
    const base = new URL(connection.profile.baseUrl);
    const boundHttp = url.protocol === 'http:' && base.protocol === 'http:' && url.origin === base.origin;
    if ((url.protocol !== 'https:' && !boundHttp) || url.username || url.password || url.hash) fail('malformed_response', 'output_source_retained');
    return url.href;
  }
  async submitVideo(connection: AuthorizedConnection, input: VideoInput, signal?: AbortSignal): Promise<RemoteTask> {
    required(input.prompt);
    const protocol = videoProtocol(connection), selectedModel = model(connection, 'video', input.model);
    validateVideoModel(protocol, selectedModel, input);
    const imagesInput = input.images ?? [];
    if (!['text', 'image', 'reference'].includes(input.mode) || !Array.isArray(imagesInput) || (input.mode === 'text' && imagesInput.length) || (input.mode === 'image' && imagesInput.length !== 1) || (input.mode === 'reference' && !imagesInput.length)) fail('invalid_input', 'not_submitted');
    if (input.duration !== undefined && (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 30)) fail('invalid_input', 'not_submitted');
    if (input.resolution !== undefined && !/^[A-Za-z0-9]{1,12}$/.test(input.resolution)) fail('invalid_input', 'not_submitted');
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647 || protocol.startsWith('minimax'))) fail('invalid_input', 'not_submitted');
    if (input.aspectRatio !== undefined && (!['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(input.aspectRatio) || protocol === 'minimax-video-v1' || (protocol === 'vidu-video' && input.mode === 'image'))) fail('invalid_input', 'not_submitted');
    const referenceLimit = protocol === 'vidu-video' ? 7 : videoModels[selectedModel]?.references ?? 9;
    if ((protocol.startsWith('minimax') && input.mode === 'reference') || imagesInput.length > referenceLimit) fail('invalid_input', 'not_submitted');
    const images = await this.references(imagesInput, protocol === 'vidu-video' ? 10 * 1024 * 1024 - 1 : protocol === 'minimax-video-v2' ? 30 * 1024 * 1024 : 20 * 1024 * 1024 - 1);
    if (images.reduce((sum, image) => sum + image.length, 0) + Buffer.byteLength(input.prompt) + 4096 > (protocol === 'vidu-video' && input.mode === 'reference' ? 20 : 64) * 1024 * 1024) fail('invalid_input', 'not_submitted');
    const parameters = { ...(input.duration !== undefined ? { duration: input.duration } : {}), ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}) };
    let data: Json;
    if (protocol === 'ark-video' || protocol === 'minimax-video-v2') {
      data = await this.request(connection, protocol === 'ark-video' ? '/api/v3' : '/v2', protocol === 'ark-video' ? '/contents/generations/tasks' : '/video_generation', 'POST', {
        model: selectedModel, content: [{ type: 'text', text: input.prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url }, role: input.mode === 'reference' ? 'reference_image' : 'first_frame' }))],
        ...parameters, ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
      }, signal, 'create');
    } else if (protocol === 'minimax-video-v1') {
      data = await this.request(connection, '/v1', '/video_generation', 'POST', { model: selectedModel, prompt: input.prompt, ...(images.length ? { first_frame_image: images[0] } : {}), ...parameters }, signal, 'create');
      if (!object(data.base_resp) || data.base_resp.status_code !== 0) fail('malformed_response', 'submission_unknown');
    } else {
      data = await this.request(connection, '/ent/v2', input.mode === 'text' ? '/text2video' : input.mode === 'image' ? '/img2video' : '/reference2video', 'POST', {
        model: selectedModel, prompt: input.prompt, ...(images.length ? { images } : {}), ...parameters, ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      }, signal, 'create');
    }
    const rawId = protocol === 'ark-video' ? data.id : data.task_id;
    const id = typeof rawId === 'string' ? token(rawId, connection.key) : undefined;
    if (!id) fail('malformed_response', 'submission_unknown');
    return { protocol, id };
  }
  private async readVideo(connection: AuthorizedConnection, task: RemoteTask, signal?: AbortSignal): Promise<RemoteTaskState> {
    checkTask(connection, task);
    const id = encodeURIComponent(task.id); let data: Json, value: Json;
    if (task.protocol === 'ark-video') {
      data = await this.request(connection, '/api/v3', `/contents/generations/tasks/${id}`, 'GET', undefined, signal, 'query'); value = data;
    } else if (task.protocol === 'minimax-video-v1') {
      data = await this.request(connection, '/v1', `/query/video_generation?task_id=${id}`, 'GET', undefined, signal, 'query'); value = data;
      if (!object(data.base_resp) || data.base_resp.status_code !== 0) fail('malformed_response', 'remote_task_retained');
    } else if (task.protocol === 'minimax-video-v2') {
      data = await this.request(connection, '/v2', `/query/video_generation/${id}`, 'GET', undefined, signal, 'query');
      if (!object(data.task)) fail('malformed_response', 'remote_task_retained'); value = data.task;
    } else {
      data = await this.request(connection, '/ent/v2', `/tasks/${id}/creations`, 'GET', undefined, signal, 'query'); value = data;
    }
    if ((value.id !== undefined && value.id !== task.id) || (value.task_id !== undefined && value.task_id !== task.id)) fail('malformed_response', 'remote_task_retained');
    const rawStatus = token(task.protocol === 'vidu-video' ? value.state : value.status, connection.key) ?? 'unrecognized';
    const status = Object.hasOwn(statuses[task.protocol], rawStatus) ? statuses[task.protocol][rawStatus] : 'unknown';
    const state: RemoteTaskState = { status, rawStatus };
    if (status === 'failed') state.error = { code: 'vendor_error', outcome: 'remote_task_retained', message: 'Provider video task failed.', vendorCode: token(value.error?.code ?? value.error?.type ?? value.err_code, connection.key) };
    if (status !== 'succeeded') return state;
    let urls: unknown[];
    if (task.protocol === 'ark-video') urls = [value.content?.video_url];
    else if (task.protocol === 'minimax-video-v2') urls = [value.content?.url];
    else if (task.protocol === 'vidu-video') {
      if (!Array.isArray(value.creations) || !value.creations.length) fail('malformed_response', 'remote_task_retained'); urls = value.creations.map(item => item?.url);
    } else {
      const fileId = typeof value.file_id === 'string' ? token(value.file_id, connection.key) : undefined; if (!fileId) fail('malformed_response', 'remote_task_retained');
      const file = await this.request(connection, '/v1', `/files/retrieve?file_id=${encodeURIComponent(fileId)}`, 'GET', undefined, signal, 'query');
      if (!object(file.base_resp) || file.base_resp.status_code !== 0) fail('malformed_response', 'remote_task_retained'); urls = [file.file?.download_url];
    }
    state.sources = urls.map(url => ({ kind: 'video', url: this.mediaUrl(connection, url) })); return state;
  }
  async queryVideo(connection: AuthorizedConnection, task: RemoteTask, signal?: AbortSignal): Promise<RemoteTaskState> {
    try { return await this.readVideo(connection, task, signal); }
    catch (error) {
      if (error instanceof ProviderError && error.detail.outcome !== 'not_submitted') throw new ProviderError({ ...error.detail, outcome: 'remote_task_retained' });
      throw error;
    }
  }
  async cancelVideo(connection: AuthorizedConnection, task: RemoteTask, signal?: AbortSignal): Promise<CancelOutcome> {
    checkTask(connection, task);
    if (task.protocol === 'minimax-video-v1') return { outcome: 'not_cancellable' };
    try {
      const id = encodeURIComponent(task.id);
      if (task.protocol === 'vidu-video') {
        const data = await this.request(connection, '/ent/v2', `/tasks/${id}/cancel`, 'POST', { id: task.id }, signal, 'cancel');
        return { outcome: Object.keys(data).length === 0 ? 'cancelled' : 'unknown' };
      }
      const state = await this.queryVideo(connection, task, signal);
      if (state.status === 'cancelled') return { outcome: 'cancelled', state };
      if (state.status !== 'queued') return { outcome: state.status === 'unknown' ? 'unknown' : 'not_cancellable', state };
      const data = await this.request(connection, task.protocol === 'ark-video' ? '/api/v3' : '/v2', task.protocol === 'ark-video' ? `/contents/generations/tasks/${id}` : `/video_generation/${id}`, 'DELETE', undefined, signal, 'cancel');
      if (task.protocol === 'minimax-video-v2') {
        if (data.task_id !== undefined && data.task_id !== task.id) return { outcome: 'unknown', state };
        if (data.action === 'cancelled') return { outcome: 'cancelled', state: { status: 'cancelled', rawStatus: 'cancelled' } };
        return { outcome: data.action === 'deleted' ? 'record_deleted' : 'unknown' };
      }
      // Ark DELETE {} may race queued→terminal and delete a record; confirm cancellation by querying.
      const after = await this.queryVideo(connection, task, signal);
      return { outcome: after.status === 'cancelled' ? 'cancelled' : 'unknown', state: after };
    } catch (error) {
      if (error instanceof ProviderError) {
        const failure = { ...error.detail, outcome: 'operation_unknown' as const };
        if (task.protocol === 'vidu-video' && (error.detail.code === 'vendor_error' || (error.detail.httpStatus === 400))) {
          try {
            const state = await this.queryVideo(connection, task, signal);
            return { outcome: state.status === 'running' ? 'not_cancellable' : 'unknown', state, error: failure };
          } catch { /* Keep the original sanitized refusal when reconciliation is unavailable. */ }
        }
        return { outcome: 'unknown', error: failure };
      }
      return { outcome: 'unknown', error: { code: 'network_error', message: 'Provider cancellation outcome is unknown.', outcome: 'operation_unknown' } };
    }
  }
  async materialize(connection: AuthorizedConnection, source: MediaSource, signal?: AbortSignal): Promise<ArtifactRef> {
    const timeout = AbortSignal.timeout(this.timeouts.downloadMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const limit = source.kind === 'image' ? imageLimit : videoLimit;
    const id = randomUUID(); let temporary: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      combined.throwIfAborted();
      if (!['image', 'video'].includes(source.kind)) fail('download_failed', 'output_source_retained');
      const directory = projectDirectory(this.projectRoot, '.mixcat', 'comfy', 'provider-artifacts');
      temporary = insideProject(this.projectRoot, join(directory, `${id}.part`));
      let base64: Buffer | undefined;
      if ('url' in source && source.url !== undefined) {
        const response = await fetch(this.mediaUrl(connection, source.url), { redirect: 'manual', signal: combined });
        if (!response.ok) { await response.body?.cancel(); fail('download_failed', 'output_source_retained', { httpStatus: response.status }); }
        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail('media_too_large', 'output_source_retained'); }
        if (!response.body) fail('download_failed', 'output_source_retained'); reader = response.body.getReader();
      } else {
        if (source.kind !== 'image' || typeof source.base64 !== 'string' || source.base64.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.base64) || source.base64.length % 4 !== 0) fail('download_failed', 'output_source_retained');
        base64 = Buffer.from(source.base64, 'base64');
      }
      file = await open(temporary, 'wx');
      const hash = createHash('sha256'), secret = Buffer.from(connection.key);
      let bytes = 0, header = Buffer.alloc(0), tail = Buffer.alloc(0);
      for (;;) {
        combined.throwIfAborted();
        const result = reader ? await reader.read() : { value: base64, done: !base64 };
        if (result.done) break;
        const chunk = Buffer.from(result.value!); base64 = undefined; bytes += chunk.length;
        if (bytes > limit) fail('media_too_large', 'output_source_retained');
        const scan = Buffer.concat([tail, chunk]);
        if (scan.includes(secret)) fail('download_failed', 'output_source_retained');
        tail = scan.subarray(Math.max(0, scan.length - secret.length + 1));
        if (header.length < 16) header = Buffer.concat([header, chunk]).subarray(0, 16);
        hash.update(chunk); await file.writeFile(chunk);
      }
      const type = mediaType(header);
      if (!type || type.kind !== source.kind) fail('download_failed', 'output_source_retained');
      await file.sync(); await file.close(); file = undefined;
      const target = insideProject(this.projectRoot, join(directory, `${id}.${type.extension}`));
      combined.throwIfAborted(); await rename(temporary, target);
      return { id, relativePath: relative(this.projectRoot, target).replaceAll('\\', '/'), mime: type.mime, sha256: hash.digest('hex'), bytes };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      return fail(signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'download_failed', 'output_source_retained');
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); await file?.close().catch(() => {}); if (temporary) await unlink(temporary).catch(() => {}); }
  }
}
