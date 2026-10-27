import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { WORKFLOW_TOOLS, type McpCallContext, type McpGateway, type McpGatewayOptions, type McpIdentity, type WorkflowTool } from '../shared/types.js';
import { WorkflowError } from './collaboration.js';

const MAX_BODY_BYTES = 1024 * 1024;
const objectSchema = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const textSchema = { type: 'string', minLength: 1 };
const requestIdSchema = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const workContextSchema = objectSchema({ primary_todo_id: { type: ['string', 'null'] }, references: { type: 'array', maxItems: 50, items: objectSchema({ projectId: textSchema, kind: { enum: ['todo', 'issue', 'document'] }, id: textSchema }) } }, []);
const nodeSchema = objectSchema({
  id: textSchema, name: textSchema, instructions: { type: 'string' }, revision: { type: 'integer', minimum: 0, description: 'Use the current revision; use 0 for a new node.' },
  tools: { type: 'array', items: { type: 'string', enum: [...WORKFLOW_TOOLS] }, uniqueItems: true }, resultSchema: { type: 'object' },
  position: objectSchema({ x: { type: 'number' }, y: { type: 'number' } }), model: { type: ['string', 'null'] },
  planId: { type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$' },
  skills: { type: 'array', items: objectSchema({ name: textSchema, path: textSchema }) }, plugins: { type: 'array', items: objectSchema({ name: textSchema, id: textSchema }) },
}, ['id', 'name', 'instructions', 'revision', 'tools', 'resultSchema', 'position']);
const edgeSchema = objectSchema({ id: textSchema, sourceNodeId: textSchema, targetNodeId: textSchema, condition: { type: 'string' }, revision: { type: 'integer', minimum: 0 } });

export const edgeToolName = (id: string, targetNodeId: string) => `edge_${createHash('sha256').update(JSON.stringify([id, targetNodeId])).digest('hex').slice(0, 32)}`;

export function toolsFor(identity: McpIdentity): Tool[] {
  const definitions: Tool[] = [
    { name: 'get_project_context', description: 'Read current project, self, task, nodes, edges and collaboration rules. Optional capability discovery may connect to the native runtime.', inputSchema: objectSchema({ include_capabilities: { type: 'boolean' } }, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    {
      name: 'complete_task', description: 'Submit the final task result, or report that the task is blocked.',
      inputSchema: objectSchema({ result: {}, blocked: { type: 'boolean' }, reason: textSchema }, ['result']),
    },
    {
      name: 'update_workflow', description: 'Save a node or directed conditional edge with operation and request_id for durable replay. Read current revisions and include_capabilities before selecting models, skills or plugins. New nodes may set initial position; updates preserve layout. New collaboration tools can only be delegated if you have them; existing workflow-edit grants may be retained but never newly granted. Legacy {node} remains available.',
      inputSchema: { ...objectSchema({ operation: { enum: ['save_node', 'save_edge'] }, request_id: requestIdSchema, node: nodeSchema, edge: edgeSchema, related_to: textSchema, condition: { type: 'string' } }, []), oneOf: [
        objectSchema({ node: { ...nodeSchema, properties: { ...nodeSchema.properties, tools: { type: 'array', items: { type: 'string', enum: ['get_project_context', 'handoff', 'complete_task'] }, uniqueItems: true } } } }),
        objectSchema({ operation: { const: 'save_node' }, request_id: requestIdSchema, node: nodeSchema, related_to: textSchema, condition: { type: 'string' } }, ['operation', 'request_id', 'node']),
        objectSchema({ operation: { const: 'save_edge' }, request_id: requestIdSchema, edge: edgeSchema }),
      ] },
    },
    { name: 'get_delivery', description: 'Read a committed message receipt and its recipient task attempts and explicit replies. Provide a message_id or your request_id.',
      inputSchema: objectSchema({ message_id: textSchema, request_id: textSchema }, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'read_history', description: 'Read original project conversation entries with optional node, task, message or reply filters. Reuse next_cursor with the same filters to continue; new entries are excluded from that traversal.',
      inputSchema: objectSchema({ node_id: textSchema, task_id: textSchema, message_id: textSchema, reply_to: textSchema, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, cursor: textSchema }, []),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'request_review', description: 'Submit a fixed version for trusted desktop human review. Returns a durable pending receipt immediately; acceptance is not approval. Use a new request_id for a changed package.',
      inputSchema: objectSchema({ request_id: requestIdSchema, checkpoint_id: textSchema, title: { type: 'string', minLength: 1, maxLength: 80 }, content: {}, comment_ids: { type: 'array', items: textSchema, uniqueItems: true, maxItems: 50, description: 'Explicit immutable Issue comments to freeze, including author and time.' }, item_ids: { type: 'array', items: textSchema, uniqueItems: true, maxItems: 50, description: 'Selected project todos/issues/documents to freeze as review materials; status-only changes do not invalidate these materials.' }, attachments: { type: 'array', items: { oneOf: [objectSchema({ path: textSchema }), objectSchema({ artifact_id: textSchema })] } } }, ['request_id', 'checkpoint_id', 'title', 'content']) },
    { name: 'get_review', description: 'Read a saved human review by review_id or your own request_id. Only the desktop user can decide; ordinary chat, native approval and agents cannot approve.',
      inputSchema: { ...objectSchema({ review_id: textSchema, request_id: requestIdSchema }, []), oneOf: [objectSchema({ review_id: textSchema }), objectSchema({ request_id: requestIdSchema })] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'search_project_items', description: 'Search this project\'s business todos, issues and Markdown documents. Returns summaries and nextCursor. Business status is separate from native execution status.',
      inputSchema: objectSchema({ text: { type: 'string' }, kind: { enum: ['todo', 'issue', 'document'] }, status: { type: 'string' }, ownerId: { type: 'string' }, archived: { type: 'boolean' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'get_project_item', description: 'Read one project item by stable id, including current version, document hash and the most recent links, comments and events. Use nextCursor to read older detail pages; refresh if concurrent updates invalidate it. Read before editing.', inputSchema: objectSchema({ id: textSchema, comment_id: textSchema, cursor: textSchema, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['id']), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'update_project_item', description: 'Maintain a project todo, issue or Markdown document. Use a stable request_id; existing items require expected_revision. Document body changes/moves/deletion and recycle-bin restoration require expected_hash from get_project_item. delete moves a document into the project recycle area; restore can specify an unoccupied path. Completion/close/reopen require reason. References use Markdown links mixcat://PROJECT_ID/KIND/ID. Changes do not dispatch work; use an existing edge tool to hand off.',
      inputSchema: objectSchema({ request_id: requestIdSchema, operation: { enum: ['create', 'edit', 'move', 'archive', 'restore', 'reopen', 'comment', 'register', 'relink', 'delete'] },
        id: textSchema, expected_revision: { type: 'integer', minimum: 0 }, expected_hash: { type: ['string', 'null'] }, kind: { enum: ['todo', 'issue', 'document'] },
        title: { type: 'string' }, body: { type: 'string' }, acceptance: { type: 'string' }, status: { type: 'string' }, priority: { enum: ['low', 'normal', 'high'] },
        ownerId: { type: ['string', 'null'] }, parentId: { type: ['string', 'null'] }, beforeId: { type: ['string', 'null'] }, issueType: { enum: ['bug', 'enhancement', 'requirement'] }, path: { type: 'string' }, reason: { type: 'string' },
      }, ['request_id', 'operation']) },
  ];
  return [...definitions.filter(tool => identity.tools.includes(tool.name as WorkflowTool)), ...(identity.edges ?? []).map(edge => ({
    name: edgeToolName(edge.id, edge.targetNodeId), title: `${edge.sourceNodeId} → ${edge.targetNodeId}`,
    description: `Send along workflow edge ${edge.id} to node ${edge.targetNodeId}. Condition: ${edge.condition || '(unspecified)'}. Acceptance queues delivery without ending your Turn; it does not mean the recipient has started or succeeded.`,
    inputSchema: objectSchema({ request_id: requestIdSchema, content: {}, reason: textSchema,
      work_context: { ...workContextSchema, description: 'Optional work association. Omit to inherit the current task (or replied-to message); provide an empty object to clear it. Never creates routing or dispatch dependencies.' },
      attachments: { type: 'array', items: { oneOf: [objectSchema({ path: textSchema }), objectSchema({ artifact_id: textSchema })] } },
      reply_to: { type: ['string', 'null'], description: 'Only set when replying to an incoming message sent by this tool\'s bound target. A handoff to a third node is a new message: omit reply_to and reference earlier message IDs in content.' },
    }, ['request_id', 'content', 'reason']),
  }))];
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
    const tools = toolsFor(identity);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const edge = identity.edges?.find(edge => edgeToolName(edge.id, edge.targetNodeId) === params.name);
      const collaboration = params.name.startsWith('edge_') || ['send_message', 'get_delivery', 'read_history', 'request_review', 'get_review'].includes(params.name) || (params.name === 'update_workflow' && !!params.arguments && Object.hasOwn(params.arguments, 'operation'));
      let invoking = false;
      try {
        if (!tools.some(tool => tool.name === params.name)) {
          if (collaboration) throw new WorkflowError('PERMISSION_DENIED', 'Tool is not available to this node.');
          throw new McpError(ErrorCode.InvalidParams, 'Tool is not available to this node.');
        }
        const context = callContext(identity, params._meta);
        if (edge) {
          if (Object.keys(params.arguments ?? {}).some(key => !['request_id', 'content', 'reason', 'attachments', 'reply_to', 'work_context'].includes(key))) throw new McpError(ErrorCode.InvalidParams, 'Edge tools accept content, reason, request_id, attachments, reply_to and work_context only.');
          context.edge = structuredClone(edge);
        }
        if (!['get_project_context', 'get_delivery', 'read_history', 'get_review', 'search_project_items', 'get_project_item'].includes(params.name) && (!context.threadId || !context.turnId || !context.callId)) {
          if (collaboration) throw new WorkflowError('PERMISSION_DENIED', 'Write operations require native Thread, Turn and call identifiers.');
          throw new McpError(ErrorCode.InvalidParams, 'Write operations require native Thread, Turn and call identifiers.');
        }
        invoking = true;
        const result = await options.invoke(edge ? 'send_message' : params.name as WorkflowTool, edge ? { ...params.arguments, to_node_id: edge.targetNodeId, route: { edge_id: edge.id, edge_revision: edge.revision } } : params.arguments ?? {}, context);
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
