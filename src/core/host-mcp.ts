import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ensureProjectDirectory, projectDirectory } from './paths.js';

export function normalizeHostMcpServer(value: any, root: string): Record<string, unknown> {
  const transport = value?.transport;
  if (value?.enabled !== true || transport?.type !== 'stdio' || typeof transport.command !== 'string' || !transport.command.trim()
    || (transport.args != null && (!Array.isArray(transport.args) || transport.args.some((arg: unknown) => typeof arg !== 'string')))
    || (transport.env != null && (typeof transport.env !== 'object' || Array.isArray(transport.env) || Object.values(transport.env).some(item => typeof item !== 'string')))
    || (transport.env_vars != null && (!Array.isArray(transport.env_vars) || transport.env_vars.some((item: unknown) => typeof item !== 'string')))) throw new Error('宿主 MCP 未启用或 stdio 配置无效。');
  const server: Record<string, unknown> = { command: transport.command, args: transport.args ?? [],
    ...(transport.env ? { env: { ...transport.env } } : {}), ...(transport.env_vars ? { env_vars: [...transport.env_vars] } : {}), cwd: root, enabled: true };
  for (const key of ['enabled_tools', 'disabled_tools']) {
    if (value[key] == null) continue;
    if (!Array.isArray(value[key]) || value[key].some((tool: unknown) => typeof tool !== 'string')) throw new Error('宿主 MCP 工具配置无效。');
    server[key] = [...value[key]];
  }
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) throw new Error('宿主 MCP 超时配置无效。');
    server[key] = value[key];
  }
  return server;
}

export async function loadHostMcpServers(executable: string, root: string, names: string[]) {
  root = ensureProjectDirectory(root);
  const directory = projectDirectory(root, '.mixcat', 'native-tools');
  const servers: Record<string, Record<string, unknown>> = {}, errors: string[] = [];
  for (const name of [...new Set(names)]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) throw new Error('宿主 MCP 名称无效。');
    try {
      const output = await new Promise<string>((resolve, reject) => execFile(executable,
        ['-c', `log_dir=${JSON.stringify(directory)}`, 'mcp', 'get', name, '--json'],
        { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
          env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory, XDG_CACHE_HOME: directory } },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      servers[name] = normalizeHostMcpServer(JSON.parse(output), root);
    } catch { errors.push(`宿主 MCP「${name}」未配置、未启用或无法读取。`); }
  }
  return { servers, errors };
}
