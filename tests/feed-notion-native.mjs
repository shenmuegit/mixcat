import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createCodexClient, runtimeEnvironment } from '../src/core/codex.ts';
import { projectDirectory } from '../src/core/paths.ts';

test('native Codex OAuth keeps separate MCP workspaces and reuses them after restart', { skip: !process.env.MIXCAT_CODEX }, async () => {
  const clients = [], profiles = [], registrations = new Map(), events = new Map(), writes = [], methods = [];
  let base;
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url, base); let body = ''; for await (const chunk of request) body += chunk;
    const json = (value, code = 200, headers = {}) => { response.writeHead(code, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { const registration = JSON.parse(body), id = randomUUID(); registrations.set(id, registration); return json({ ...registration, client_id: id }, 201); }
    if (url.pathname === '/authorize') {
      assert(registrations.has(url.searchParams.get('client_id'))); assert(url.searchParams.get('code_challenge')); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('code', url.searchParams.get('workspace')); redirect.searchParams.set('state', url.searchParams.get('state'));
      response.writeHead(302, { Location: redirect.href }); response.end(); return;
    }
    if (url.pathname === '/token') { const params = new URLSearchParams(body); assert(params.get('code_verifier')); return json({ access_token: `fixture-${params.get('code')}`, refresh_token: `refresh-${params.get('code')}`, token_type: 'Bearer', expires_in: 3600 }); }
    if (url.pathname === '/mcp') {
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      if (!request.headers.authorization) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const workspace = request.headers.authorization.slice('Bearer fixture-'.length), rpc = JSON.parse(body); methods.push(rpc.method);
      const reply = result => json({ jsonrpc: '2.0', id: rpc.id, result });
      if (rpc.method === 'initialize') return reply({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Notion fixture', version: '1.0.0' } });
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      if (rpc.method === 'tools/list') return reply({ tools: ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-create-pages'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true }, annotations: { readOnlyHint: name !== 'notion-create-pages' } })) });
      if (rpc.method === 'tools/call') {
        const args = rpc.params.arguments ?? {};
        const result = rpc.params.name === 'notion-get-self' ? { workspace: { id: workspace, name: `Team ${workspace}` } }
          : rpc.params.name === 'notion-create-pages' ? (writes.push({ workspace, args }), { pages: [{ id: `created-${workspace}`, url: `https://www.notion.so/created-${workspace}` }] })
          : { results: [{ id: `page-${workspace}`, title: `Results ${workspace}`, url: `https://www.notion.so/page-${workspace}` }] };
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      }
      if (rpc.method === 'resources/list') return reply({ resources: [] });
      if (rpc.method === 'resources/templates/list') return reply({ resourceTemplates: [] });
      return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
    }
    response.writeHead(404); response.end();
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  const fixture = projectDirectory(process.cwd(), '.runtime', 'implementation', 'feed', `notion-native-${randomUUID()}`);
  function native(profile) {
    const client = createCodexClient({ executable: process.env.MIXCAT_CODEX, cwd: fixture, home: profile.home, onEvent(event) { if (event.method === 'mcpServer/oauthLogin/completed') events.set(profile.name, event.params); }, onDisconnect() {} }); clients.push(client); return client;
  }
  try {
    for (const workspace of ['A', 'B']) {
      const profile = { name: `notion_fixture_${workspace}_${randomUUID().replaceAll('-', '')}`, home: projectDirectory(fixture, workspace, '.codex') }; profiles.push(profile);
      const client = native(profile); await client.connect();
      await client.rpc('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${profile.name}`, value: { url: `${base}/mcp` }, mergeStrategy: 'upsert' }], reloadUserConfig: true });
      await client.rpc('config/mcpServer/reload', {});
      const login = await client.rpc('mcpServer/oauth/login', { name: profile.name, timeoutSecs: 15 });
      const authorization = new URL(login.authorizationUrl); authorization.searchParams.set('workspace', workspace);
      const redirect = await fetch(authorization, { redirect: 'manual' }); assert.equal(redirect.status, 302);
      await fetch(redirect.headers.get('location'));
      for (let i = 0; i < 100 && !events.has(profile.name); i++) await new Promise(done => setTimeout(done, 50));
      assert.equal(events.get(profile.name)?.success, true); assert.equal(events.get(profile.name)?.loginId, login.loginId);
      await client.rpc('config/mcpServer/reload', {});
      const thread = await client.rpc('thread/start', { cwd: fixture, sandbox: 'workspace-write', approvalPolicy: 'on-request' }); profile.threadId = thread.thread.id;
      const call = async (tool, args) => JSON.parse((await client.rpc('mcpServer/tool/call', { threadId: profile.threadId, server: profile.name, tool, arguments: args })).content[0].text);
      assert.equal((await call('notion-get-self', {})).workspace.id, workspace);
      await call('notion-create-pages', { parent: { page_id: `page-${workspace}` }, pages: [{ properties: { title: `Feed_${workspace}` }, content: `# Result ${workspace}` }] });
      await client.close();
    }
    for (const [index, profile] of profiles.entries()) {
      const client = native(profile); await client.connect();
      profile.threadId = (await client.rpc('thread/start', { cwd: fixture, sandbox: 'workspace-write', approvalPolicy: 'on-request' })).thread.id;
      const result = await client.rpc('mcpServer/tool/call', { threadId: profile.threadId, server: profile.name, tool: 'notion-get-self', arguments: {} });
      assert.equal(JSON.parse(result.content[0].text).workspace.id, index ? 'B' : 'A');
      await client.close();
    }
    assert.deepEqual(writes.map(write => [write.workspace, write.args.parent.page_id]), [['A', 'page-A'], ['B', 'page-B']]);
    console.log(JSON.stringify({ fixture, nativeOAuth: true, separateWorkspaces: true, restartCredentials: true, nativeToolWrites: writes.length }));
  } catch (error) { console.log(JSON.stringify({ nativeMethods: methods })); throw error; }
  finally {
    await Promise.allSettled(clients.map(client => client.close()));
    try { for (const profile of profiles) execFileSync(process.env.MIXCAT_CODEX, ['mcp', 'logout', profile.name], { cwd: fixture, env: runtimeEnvironment(fixture, profile.home), windowsHide: true, timeout: 10000, stdio: 'pipe' }); }
    finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  }
});
