import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { WORKFLOW_TOOLS, type McpCallContext, type McpGateway, type McpGatewayOptions, type McpIdentity, type WorkflowTool } from '../shared/types.js';
import { WorkflowError } from './collaboration.js';

const MAX_BODY_BYTES = 1024 * 1024;
const objectSchema = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const textSchema = { type: 'string', minLength: 1 };

function toolsFor(identity: McpIdentity): Tool[] {
  const definitions: Tool[] = [
    { name: 'get_project_context', description: 'Read current project, self, task, nodes, edges and collaboration rules. Optional capability discovery may connect to the native runtime.', inputSchema: objectSchema({ include_capabilities: { type: 'boolean' } }, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    {
      name: 'handoff', description: 'Submit your result and request that another node perform the next task.',
      inputSchema: objectSchema({ to_node_id: textSchema, task: textSchema, reason: textSchema, result: {} }),
    },
    {
      name: 'complete_task', description: 'Submit the final task result, or report that the task is blocked.',
      inputSchema: objectSchema({ result: {}, blocked: { type: 'boolean' }, reason: textSchema }, ['result']),
    },
    {
      name: 'update_workflow', description: 'Create or update a node in the current workflow. Position sets the initial layout for new nodes; updates preserve the current layout.',
      inputSchema: objectSchema({ node: objectSchema({
        id: textSchema, name: textSchema, instructions: { type: 'string' }, revision: { type: 'integer', minimum: 0, description: 'Use the revision read from get_project_context; use 0 for a new node.' },
        tools: { type: 'array', items: { type: 'string', enum: [...WORKFLOW_TOOLS] }, uniqueItems: true },
        resultSchema: { type: 'object' }, position: objectSchema({ x: { type: 'number' }, y: { type: 'number' } }),
      }) }),
    },
    {
      name: 'send_message', description: 'Send one durable message or explicit reply to another project node. Acceptance queues delivery without ending your current Turn; it does not mean the recipient has started or succeeded.',
      inputSchema: objectSchema({ request_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }, to_node_id: textSchema, content: {}, reason: textSchema,
        attachments: { type: 'array', items: { oneOf: [objectSchema({ path: textSchema }), objectSchema({ artifact_id: textSchema })] } },
        reply_to: { type: ['string', 'null'] }, route: { anyOf: [objectSchema({ edge_id: textSchema, edge_revision: { type: 'integer', minimum: 1 } }), { type: 'null' }] },
      }, ['request_id', 'to_node_id', 'content', 'reason']),
    },
    { name: 'get_delivery', description: 'Read a committed message receipt and its recipient task attempts and explicit replies. Provide a message_id or your request_id.',
      inputSchema: objectSchema({ message_id: textSchema, request_id: textSchema }, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'read_history', description: 'Read original project conversation entries with optional node, task, message or reply filters. Reuse next_cursor with the same filters to continue; new entries are excluded from that traversal.',
      inputSchema: objectSchema({ node_id: textSchema, task_id: textSchema, message_id: textSchema, reply_to: textSchema, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, cursor: textSchema }, []),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ];
  return definitions.filter(tool => identity.tools.includes(tool.name as WorkflowTool));
}

function callContext(identity: McpIdentity, meta: Record<string, unknown> = {}): McpCallContext {
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); }
    catch { throw new McpError(ErrorCode.InvalidParams, 'Invalid native Turn metadata.'); }
  }
  const identifier = (value: unknown) => typeof value === 'string' && value.trim() ? value : '';
  return {
    identity, threadId: identifier(meta.threadId), callId: identifier(meta.callId),
    turnId: identifier(turn && typeof turn === 'object' && !Array.isArray(turn) ? (turn as Record<string, unknown>).turn_id : undefined),
  };
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

export async function startMcpGateway(options: McpGatewayOptions): Promise<McpGateway> {
  let host = '';
  const active = new Set<Server>();
  const http = createServer((request, response) => {
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
    const tools = toolsFor(identity);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const collaboration = ['send_message', 'get_delivery', 'read_history'].includes(params.name);
      let invoking = false;
      try {
        if (!tools.some(tool => tool.name === params.name)) {
          if (collaboration) throw new WorkflowError('PERMISSION_DENIED', 'Tool is not available to this node.');
          throw new McpError(ErrorCode.InvalidParams, 'Tool is not available to this node.');
        }
        const context = callContext(identity, params._meta);
        if (!['get_project_context', 'get_delivery', 'read_history'].includes(params.name) && (!context.threadId || !context.turnId || !context.callId)) {
          if (collaboration) throw new WorkflowError('PERMISSION_DENIED', 'Write operations require native Thread, Turn and call identifiers.');
          throw new McpError(ErrorCode.InvalidParams, 'Write operations require native Thread, Turn and call identifiers.');
        }
        invoking = true;
        const result = await options.invoke(params.name as WorkflowTool, params.arguments ?? {}, context);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result as Record<string, unknown> } : {}),
        };
      } catch (error) {
        if (!collaboration && !invoking) throw error;
        const message = error instanceof Error ? error.message : 'Workflow operation failed.';
        return { isError: true, content: [{ type: 'text' as const, text: message }], ...(collaboration ? { structuredContent: { error: { code: error instanceof WorkflowError ? error.code : error instanceof McpError ? error.code : ErrorCode.InternalError, message } } } : {}) };
      }
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
  return {
    url: `http://${host}/mcp`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      http.closeAllConnections();
      await Promise.all([closed, ...[...active].map(server => server.close())]);
    },
  };
}
