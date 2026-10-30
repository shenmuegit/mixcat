import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

const MAX_BODY_BYTES = 1024 * 1024;
export interface McpTransport { url: string; close(): Promise<void>; }
export interface McpTransportOptions<I> {
  resolveIdentity(token: string): I | undefined;
  toolsFor(identity: I): Tool[];
  invoke(identity: I, params: CallToolRequest['params']): Promise<CallToolResult>;
  unavailable(identity: I, params: CallToolRequest['params']): CallToolResult | Promise<CallToolResult>;
}

function rejectRequest(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | undefined> {
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    rejectRequest(response, 413, 'Request body is too large.');
    request.resume();
    return;
  }
  return await new Promise((resolve, reject) => {
    let size = 0;
    let chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks = [];
        if (!response.writableEnded) rejectRequest(response, 413, 'Request body is too large.');
        resolve(undefined);
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => resolve(undefined));
  });
}

export async function startMcpTransport<I>(options: McpTransportOptions<I>): Promise<McpTransport> {
  let host = '';
  const active = new Set<Server>();
  const http = createServer((request, response) => {
    // Native clients can reuse a pooled socket just as the server's idle timer closes it.
    response.setHeader('Connection', 'close');
    void handle(request, response).catch(() => {
      if (!response.headersSent) rejectRequest(response, 500, 'MCP request failed.');
      else if (!response.writableEnded) response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      rejectRequest(response, 403, 'Host or Origin is not allowed.'); return;
    }
    if (request.url !== '/mcp') { rejectRequest(response, 404, 'Not found.'); return; }
    if (request.method !== 'POST') { rejectRequest(response, 405, 'Method not allowed.'); return; }
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const identity = token ? options.resolveIdentity(token) : undefined;
    if (!identity) { rejectRequest(response, 401, 'Authentication required.'); return; }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(response, 415, 'Content-Type must be application/json.'); return;
    }
    const body = await readBody(request, response);
    if (!body) return;
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { rejectRequest(response, 400, 'Invalid JSON.'); return; }

    // Each request owns its tool catalog; MCP sessions never establish node identity.
    const server = new Server({ name: 'mixcat', version: '0.1.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const tools = options.toolsFor(identity);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (!tools.some(tool => tool.name === params.name)) return options.unavailable(identity, params);
      return options.invoke(identity, params);
    });
    active.add(server);
    response.once('close', () => { active.delete(server); void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(request, response, parsed);
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP did not bind a TCP port.');
  host = `127.0.0.1:${address.port}`;
  let closingHttp: Promise<void> | undefined;
  return {
    url: `http://${host}/mcp`,
    async close() {
      const closed = closingHttp ??= (http.listening ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve()).catch(error => { closingHttp = undefined; throw error; });
      http.closeAllConnections();
      await Promise.all([closed, ...[...active].map(server => server.close())]);
    },
  };
}
