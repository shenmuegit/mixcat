import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ComfyRuns, type ProviderJobInput } from '../core/comfy-runs.js';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { registerArtifact, verifiedArtifactPath } from '../core/comfy-artifacts.js';
import { insideProject } from '../core/paths.js';

/** Private loopback process capability, never exposed to the renderer or workflow. */
export class ComfyBroker {
  private token = randomBytes(32).toString('hex');
  private server = createServer((request, response) => { void this.handle(request, response); });
  constructor(private runs: ComfyRuns, readonly instanceId: string) {}
  async start() {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return { origin: `http://127.0.0.1:${(this.server.address() as { port: number }).port}`, token: this.token };
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(request.headers.authorization ?? '')), expected = Buffer.from(`Bearer ${this.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.headers['x-mixcat-instance'] !== this.instanceId || request.headers.origin) { reply(403, { error: 'Process authentication required.' }); return; }
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/v1/connections') { reply(200, this.runs.connections()); return; }
      const promptId = request.headers['x-mixcat-prompt'];
      if (typeof promptId !== 'string') throw Error('Prompt identity required.');
      const run = this.runs.store.runForPrompt(promptId);
      if (!run || run.observation.instanceId !== this.instanceId) throw Error('Run identity conflict.');
      if (request.method === 'POST' && path === '/v1/artifacts') {
        const body = await this.body(request) as { relativePath?: unknown };
        if (Object.keys(body).length !== 1 || typeof body.relativePath !== 'string' || isAbsolute(body.relativePath) || /^[a-z]:/i.test(body.relativePath)) throw Error('Relative reference path required.');
        const inputRoot = insideProject(this.runs.store.root, join(this.runs.store.root, this.runs.store.runtimeRecord<string>('instance-data:' + this.instanceId) ?? '.mixcat/comfy/data', 'input'));
        const file = insideProject(inputRoot, resolve(this.runs.store.root, body.relativePath));
        const artifact = await registerArtifact(this.runs.store.root, file);
        if (!artifact.mime.startsWith('image/') || artifact.bytes > 48 * 1024 * 1024) throw Error('Reference image required.');
        this.runs.store.registerArtifact(run.id, artifact); reply(200, artifact); return;
      }
      const artifactMatch = /^\/v1\/artifacts\/([a-f0-9-]+)$/.exec(path);
      if (request.method === 'GET' && artifactMatch) {
        const artifact = this.runs.store.artifact(run.id, artifactMatch[1]); if (!artifact) throw Error('Artifact identity conflict.');
        const file = await verifiedArtifactPath(this.runs.store.root, artifact);
        response.writeHead(200, { 'Content-Type': artifact.mime, 'Content-Length': artifact.bytes, 'Cache-Control': 'no-store' });
        await pipeline(createReadStream(file), response); return;
      }
      if (request.method === 'POST' && path === '/v1/jobs') {
        const input = await this.body(request) as ProviderJobInput;
        if (input.instanceId !== this.instanceId || input.promptId !== promptId) throw Error('Run identity conflict.');
        reply(200, await this.runs.submit(input)); return;
      }
      const match = /^\/v1\/jobs\/([a-f0-9-]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        if (this.runs.store.providerJob(match[1])?.runId !== run.id) throw Error('Job identity conflict.');
        reply(200, this.runs.job(match[1])); return;
      }
      const stop = /^\/v1\/jobs\/([a-f0-9-]+)\/stop$/.exec(path);
      if (request.method === 'POST' && stop) {
        if (this.runs.store.providerJob(stop[1])?.runId !== run.id) throw Error('Job identity conflict.');
        const body = await this.body(request) as { action: 'stop_waiting' | 'cancel_remote' };
        if (Object.keys(body).length !== 1 || !['stop_waiting', 'cancel_remote'].includes(body.action)) throw Error('Invalid stop action.');
        reply(200, await this.runs.stopJob(stop[1], body.action)); return;
      }
      reply(404, { error: 'Route not found.' });
    } catch { if (!response.headersSent) reply(400, { error: 'Provider broker request rejected.' }); else response.destroy(); }
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async close() { if (!this.server.listening) return; this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); }
}
