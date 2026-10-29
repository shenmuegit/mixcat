import { z } from 'zod';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startMcpTransport } from './mcp-transport.js';
import type { FeedEngine } from './feed-runtime.js';
import { feedId } from './feed-collections.js';

export interface FeedMcpIdentity { token: string; collectionId: string; }
const entry = z.strictObject({ requestId: feedId, title: z.string(), body: z.string(), aiSummary: z.string().optional(), sourceUrl: z.string().optional(), publishedAt: z.string().optional(), coverage: z.enum(['full', 'partial', 'excerpt']), referenceEntryIds: z.array(feedId).optional() });
const tools: Tool[] = [{ name: 'save_feed_result', description: 'Save a text result, including sources and limitations. Only an accepted receipt confirms storage. Retry the identical requestId for lost replies.', inputSchema: z.toJSONSchema(entry) as Tool['inputSchema'], annotations: { readOnlyHint: false } }];
const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorResult = (error: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] });

export function startFeedMcp(engine: FeedEngine) {
  return startMcpTransport<FeedMcpIdentity>({
    resolveIdentity: token => engine.resolveIdentity(token), toolsFor: () => tools,
    unavailable: () => errorResult(new Error('个人采集工具不可用。')),
    async invoke(identity, params) {
      try {
        const service = engine.mcpService(); let value: unknown;
        switch (params.name) {
          case 'save_feed_result': { const actor = engine.actor(identity, params._meta ?? {}); const { requestId, ...input } = entry.parse(params.arguments); value = service.saveResult(requestId, input, actor, () => engine.admitWrite(actor)); break; }
          default: throw new Error('个人采集工具不可用。');
        }
        engine.changed(); return result(value);
      } catch (error) { return errorResult(error); }
    },
  });
}
