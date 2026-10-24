import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

const slug = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const hookFiles = ['codex_hook_adapter.py', 'context_frame.py', 'run_sh.py', 'pre_tool_use.py', 'post_tool_use.py', 'permission_request.py', 'stop.py', 'session-start.sh', 'user-prompt-submit.sh', 'pre-tool-use.sh', 'post-tool-use.sh', 'pre-compact.sh', 'stop.sh', 'resolve-plan-dir.sh'];
const helperFiles = ['resolve-plan-dir.sh', 'check-complete.sh', 'session-catchup.py'];
const events = {
  SessionStart: 'startup|resume|clear|compact', UserPromptSubmit: undefined,
  PreToolUse: 'Bash|apply_patch|Edit|Write', PermissionRequest: undefined,
  PostToolUse: 'apply_patch|Edit|Write', PreCompact: '*', Stop: undefined,
};

export interface PlanningRuntime {
  hookConfigPath: string;
  adapterPath: string;
  bindingsPath: string;
  pythonExecutable: string;
  officialFiles: { source: string; target: string; sha256: string }[];
  initialSessionBinding: 'unbound';
  trust: 'host-required';
}

export class PlanningBindingSkippedError extends Error {}

function noLinks(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`规划路径不能经过符号链接或目录联接：${current}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return resolve(path);
}

function officialSources(skillPath: string) {
  if (!isAbsolute(skillPath)) throw new Error('planning-with-files skill 必须使用绝对路径。');
  const selected = noLinks(skillPath), skillRoot = statSync(selected).isDirectory() ? selected : dirname(selected);
  const entry = noLinks(join(skillRoot, 'SKILL.md'));
  if (!statSync(entry).isFile()) throw new Error('planning-with-files skill 缺少 SKILL.md。');
  const candidates = [join(skillRoot, '.codex', 'hooks')];
  if (basename(dirname(skillRoot)).toLowerCase() === 'skills') {
    const host = dirname(dirname(skillRoot));
    candidates.push(join(host, 'hooks'));
    if (basename(host).toLowerCase() === '.agents') candidates.push(join(dirname(host), '.codex', 'hooks'));
    candidates.push(join(host, '.codex', 'hooks'));
  }
  const hooks = candidates.find(candidate => hookFiles.every(file => existsSync(join(candidate, file))));
  if (!hooks) throw new Error('所选 planning-with-files skill 未找到完整的官方 Codex handlers。');
  return [
    ...hookFiles.map(file => ({ source: noLinks(join(hooks, file)), relative: join('official', 'hooks', file) })),
    ...helperFiles.map(file => ({ source: noLinks(join(skillRoot, 'scripts', file)), relative: join('official', 'skills', 'planning-with-files', 'scripts', file) })),
  ].map(file => {
    if (!statSync(file.source).isFile()) throw new Error(`规划源不是普通文件：${file.source}`);
    return { ...file, data: readFileSync(file.source) };
  });
}

function pythonExecutable(): string {
  for (const [command, args] of [['python3', []], ['python', []], ['py', ['-3']]] as [string, string[]][]) {
    const result = spawnSync(command, [...args, '-I', '-B', '-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status === 0 && result.stdout.trim() && existsSync(result.stdout.trim())) return realpathSync.native(result.stdout.trim());
  }
  throw new Error('planning-with-files hooks 需要可运行的 Python 3.10+。');
}

type Hook = { command?: string; commandWindows?: string; [key: string]: unknown };
type HookGroup = { hooks: Hook[]; [key: string]: unknown };
function readConfig(path: string): { hooks: Record<string, HookGroup[]>; [key: string]: unknown } {
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('项目 hooks 配置必须是对象。');
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('项目 hooks 定义必须是对象。');
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.some((hook: unknown) => !hook || typeof hook !== 'object'))) throw new Error('已有 hooks 定义格式无效，未覆盖。');
  }
  return config;
}

function atomicWrite(root: string, path: string, data: string | Buffer) {
  insideProject(root, path);
  projectDirectory(root, relative(root, dirname(path)));
  const temporary = insideProject(root, `${path}.${randomUUID()}.tmp`);
  writeFileSync(temporary, data, { flag: 'wx' });
  renameSync(temporary, path);
}

function readBindings(root: string, path: string): { version: 1; root: string; threads: Record<string, string> } {
  if (!existsSync(path)) return { version: 1, root, threads: {} };
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (saved?.version !== 1 || saved.root !== root || !saved.threads || typeof saved.threads !== 'object' || Array.isArray(saved.threads)
    || Object.entries(saved.threads).some(([id, plan]) => !id || typeof plan !== 'string' || !slug.test(plan))) throw new Error('规划 binding root 或映射格式无效。');
  return saved;
}

export function preparePlanningRuntime(root: string, skillPath: string): PlanningRuntime {
  root = ensureProjectDirectory(root);
  // Git Bash leaves apostrophe paths unconverted for the official nested Python calls.
  if (process.platform === 'win32' && root.includes("'")) throw new Error('官方 PWF Windows hooks 暂不支持路径中的英文单引号。');
  const runtime = insideProject(root, join(root, '.mixcat', 'planning'));
  const hookConfigPath = insideProject(root, join(root, '.mixcat', 'codex', 'hooks.json'));
  const legacyConfigPath = insideProject(root, join(root, '.codex', 'hooks.json'));
  const adapterPath = insideProject(root, join(runtime, 'adapter.py'));
  const bindingsPath = insideProject(root, join(runtime, 'threads.json'));
  const launcherPath = insideProject(root, join(runtime, 'hook.cmd'));
  const config = readConfig(hookConfigPath), sources = officialSources(skillPath);
  const legacyConfig = existsSync(legacyConfigPath) ? readConfig(legacyConfigPath) : undefined;
  let legacyChanged = false;
  readBindings(root, bindingsPath);
  const python = pythonExecutable();
  if (process.platform === 'win32' && /[%!&|<>^"\r\n]/.test(python)) throw new Error('Python 路径无法安全写入 Windows hook 命令。');
  const officialFiles = sources.map(file => ({ ...file, target: insideProject(root, join(runtime, file.relative)) }));
  for (const [event, matcher] of Object.entries(events)) {
    const command = `'${python.replaceAll("'", "'\\''")}' -I -B .mixcat/planning/adapter.py ${event}`;
    const commandWindows = `cmd /d /c .mixcat\\planning\\hook.cmd ${event}`;
    const withoutGenerated = (groups: HookGroup[]) => groups.flatMap(group => {
      const retained = group.hooks.filter(hook => hook.command !== command && hook.commandWindows !== commandWindows);
      if (retained.length === group.hooks.length) return [group];
      return retained.length ? [{ ...group, hooks: retained }] : [];
    });
    const groups = withoutGenerated(config.hooks[event] ?? []);
    config.hooks[event] = [...groups, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, commandWindows, timeout: 30 }] }];
    if (legacyConfig?.hooks[event]) {
      const retained = withoutGenerated(legacyConfig.hooks[event]);
      if (JSON.stringify(retained) !== JSON.stringify(legacyConfig.hooks[event])) legacyChanged = true;
      legacyConfig.hooks[event] = retained;
    }
  }
  // Validate every destination before the first write; unrelated definitions stay intact.
  for (const file of officialFiles) atomicWrite(root, file.target, file.data);
  atomicWrite(root, adapterPath, adapterSource);
  atomicWrite(root, launcherPath, `@echo off\r\n"${python}" -I -B "%~dp0adapter.py" %1\r\n`);
  atomicWrite(root, hookConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  if (legacyChanged) atomicWrite(root, legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
  return { hookConfigPath, adapterPath, bindingsPath, pythonExecutable: python,
    officialFiles: officialFiles.map(({ source, target, data }) => ({ source, target, sha256: createHash('sha256').update(data).digest('hex') })),
    initialSessionBinding: 'unbound', trust: 'host-required' };
}

export function bindPlanningThread(root: string, threadId: string, planId?: string): void {
  root = ensureProjectDirectory(root);
  if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || /[\x00-\x1f\x7f]/.test(threadId)) throw new Error('原生 Thread ID 无效。');
  const path = insideProject(root, join(root, '.mixcat', 'planning', 'threads.json'));
  const saved = readBindings(root, path);
  const clear = () => {
    if (!Object.hasOwn(saved.threads, threadId)) return;
    delete saved.threads[threadId];
    atomicWrite(root, path, `${JSON.stringify(saved, null, 2)}\n`);
  };
  if (planId === undefined) { clear(); return; }
  try {
    if (typeof planId !== 'string' || !slug.test(planId)) throw new Error('PLAN_ID 必须是安全的计划标识。');
    const plan = insideProject(root, join(root, '.planning', planId, 'task_plan.md'));
    if (!existsSync(plan) || !statSync(plan).isFile()) throw new Error('PLAN_ID 未指向已有的项目计划。');
    const sessions = insideProject(root, join(root, '.planning', 'sessions'));
    if (existsSync(sessions)) {
      const hash = createHash('sha256');
      for (const value of ['codex', (process.platform === 'win32' ? root.toLowerCase() : root).replaceAll('\\', '/'), threadId]) {
        const bytes = Buffer.from(value), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
      }
      const sentinel = insideProject(root, join(sessions, `${hash.digest('hex')}.attached`));
      atomicWrite(root, sentinel, '');
    }
    saved.threads = { ...saved.threads, [threadId]: planId };
    atomicWrite(root, path, `${JSON.stringify(saved, null, 2)}\n`);
  } catch (error) {
    clear();
    throw new PlanningBindingSkippedError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

const adapterSource = String.raw`#!/usr/bin/env python3
"""Select only the mapped native session; delegate to unmodified PWF handlers."""
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys

sys.dont_write_bytecode = True
HANDLERS = {
    "SessionStart": ("run_sh.py", "session-start.sh"),
    "UserPromptSubmit": ("run_sh.py", "user-prompt-submit.sh"),
    "PreToolUse": ("pre_tool_use.py",), "PostToolUse": ("post_tool_use.py",),
    "PermissionRequest": ("permission_request.py",),
    "PreCompact": ("run_sh.py", "pre-compact.sh"), "Stop": ("stop.py",),
}

def checked(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("linked path")
    return path.resolve(strict=True)

def same(left, right):
    return os.path.normcase(str(left)) == os.path.normcase(str(right))

def main():
    event = sys.argv[1] if len(sys.argv) == 2 else ""
    if event not in HANDLERS:
        raise ValueError("unknown event")
    root = checked(Path(__file__).absolute().parents[2])
    if root.drive.lower() == "c:" or str(root).startswith(("\\\\", "//")):
        raise ValueError("project root")
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or not isinstance(payload.get("cwd"), str) or not Path(payload["cwd"]).is_absolute() or not same(checked(payload["cwd"]), root):
        raise ValueError("cwd does not match project")
    pin = os.environ.get("PWF_PLAN_ROOT")
    if pin and (not Path(pin).is_absolute() or not same(checked(pin), root)):
        raise ValueError("project pin does not match")
    bindings = root / ".mixcat" / "planning" / "threads.json"
    if not bindings.exists():
        raise ValueError("unbound session")
    saved = json.loads(checked(bindings).read_text(encoding="utf-8"))
    if saved.get("version") != 1 or not same(saved.get("root"), root):
        raise ValueError("binding root does not match")
    session = payload.get("session_id")
    threads = saved.get("threads")
    if not isinstance(session, str) or not session or not isinstance(threads, dict):
        raise ValueError("unbound session")
    plan = threads.get(session)
    if not isinstance(plan, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]*", plan):
        raise ValueError("unbound session")
    plan_file = checked(root / ".planning" / plan / "task_plan.md")
    if not plan_file.is_file() or not plan_file.is_relative_to(root):
        raise ValueError("invalid plan pin")
    runtime = checked(root / ".mixcat" / "planning")
    cache = runtime / "cache"
    if cache.exists():
        checked(cache)
    cache.mkdir(exist_ok=True)
    os.environ.update({"PWF_PLAN_ROOT": str(root), "PLAN_ID": plan, "PWF_SESSION_ID": session,
        "XDG_CACHE_HOME": str(cache), "TEMP": str(cache), "TMP": str(cache), "TMPDIR": str(cache),
        "PYTHONDONTWRITEBYTECODE": "1"})
    handlers = checked(runtime / "official" / "hooks")
    args = HANDLERS[event]
    target = checked(handlers / args[0])
    sys.path.insert(0, str(handlers))
    sys.argv = [str(target), *args[1:]]
    # Official handlers consume the original native payload and own their output schema.
    import io
    sys.stdin = io.StringIO(json.dumps(payload))
    runpy.run_path(str(target), run_name="__main__")

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print("[mixcat planning] skipped: " + str(exc), file=sys.stderr)
`;
