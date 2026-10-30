import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyRuntime, installRuntime, prepareRuntime, runtimeEnvironment, type RuntimeManifest, type PreparationIO } from '../src/core/comfy-runtime.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function fixture() {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-runtime-'));
  const artifact = { url: 'https://example.invalid/runtime.zip', sha256: digest('official archive') };
  const manifest: RuntimeManifest = { id: 'test-v1', python: { ...artifact, version: '3.14.10' }, backend: { repository: 'https://github.com/Comfy-Org/ComfyUI.git', tag: 'v0.43.0', version: '0.43.0', commit: '426f5eea52a7ece1dd599fff4cb6cd1f352ddd24' }, frontendVersion: '1.57.4', lockSha256: digest('\n'), packages: [] };
  const io: PreparationIO = {
    download: async (_url, destination) => { writeFileSync(destination, 'official archive'); },
    install: async prepared => { writeFileSync(prepared.python, 'fake executable'); writeFileSync(join(prepared.backend, 'main.py'), '# fixture'); writeFileSync(join(prepared.backend, 'LICENSE'), 'fixture license'); }
  };
  return { root, manifest, io };
}

test('preparation publishes a project-contained version only after verified installation', async () => {
  const f = fixture();
  const prepared = await prepareRuntime(f.root, f.manifest, f.io);
  assert.ok(prepared.directory.startsWith(f.root + '\\'));
  assert.ok(existsSync(join(prepared.directory, 'ready.json')));
  assert.equal(prepared.version, 'test-v1');
  await assert.rejects(prepareRuntime(f.root, { ...f.manifest, id: '../escape' }, f.io), /版本|version/i);
  await assert.rejects(prepareRuntime('C:\\outside', f.manifest, f.io), /C 盘/);
  await assert.rejects(prepareRuntime(f.root, { ...f.manifest, lockSha256: '0'.repeat(64) }, f.io), /依赖锁 SHA-256/);
});

test('corrupt downloads never publish ready and a failed install can be retried once concurrently', async () => {
  const f = fixture();
  await assert.rejects(prepareRuntime(f.root, f.manifest, { ...f.io, download: async (_url, path) => { writeFileSync(path, 'corrupt'); } }), /SHA-256/);
  let attempts = 0;
  const io: PreparationIO = { ...f.io, install: async (prepared, downloads) => {
    attempts++;
    if (attempts === 1) throw new Error('install fixture failure');
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.io.install(prepared, downloads);
  } };
  await assert.rejects(prepareRuntime(f.root, f.manifest, io), /install fixture failure/);
  assert.equal(existsSync(join(f.root, '.mixcat', 'comfy', 'runtime', 'test-v1', 'ready.json')), false);
  const [first, second] = await Promise.all([prepareRuntime(f.root, f.manifest, io), prepareRuntime(f.root, f.manifest, io)]);
  assert.deepEqual(first, second);
  assert.equal(attempts, 2);
});

test('an incomplete installer cannot leave a ready marker that prevents retry', async () => {
  const f = fixture();
  await assert.rejects(prepareRuntime(f.root, f.manifest, { ...f.io, install: async () => {} }), /损坏/);
  assert.equal(existsSync(join(f.root, '.mixcat', 'comfy', 'runtime', 'test-v1', 'ready.json')), false);
  assert.equal((await prepareRuntime(f.root, f.manifest, f.io)).version, 'test-v1');
});

test('directory junctions and a conflicting lock manifest are rejected', async () => {
  const f = fixture(), outside = fixture();
  symlinkSync(outside.root, join(f.root, '.mixcat'), 'junction');
  try { await assert.rejects(prepareRuntime(f.root, f.manifest, f.io), /符号链接|目录联接/); }
  finally { unlinkSync(join(f.root, '.mixcat')); }
  await prepareRuntime(f.root, f.manifest, f.io);
  await assert.rejects(prepareRuntime(f.root, { ...f.manifest, python: { ...f.manifest.python, version: '3.14.9' } }, f.io), /清单冲突/);
});

test('preparation waits for the other preparer and can retry when its lock connection closes', async () => {
  const f = fixture();
  const directory = projectDirectory(f.root, '.mixcat', 'comfy', 'runtime', f.manifest.id);
  const other = new DatabaseSync(join(directory, 'prepare.sqlite'));
  other.exec('BEGIN IMMEDIATE');
  const preparing = prepareRuntime(f.root, f.manifest, f.io);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(existsSync(join(directory, 'ready.json')), false);
  } finally { other.close(); }
  assert.equal((await preparing).version, f.manifest.id);
});

test('runtime owns a child, verifies frontend/core health and rotates instance identity after restart', async t => {
  const f = fixture();
  let launchedInstanceId: string | undefined;
  const runtime = new ComfyRuntime({ preparationIO: f.io, spawn: (_python, args, options) => {
    assert.ok(args.includes('--cpu'));
    assert.ok(args.includes('--disable-auto-launch'));
    assert.equal(args[args.indexOf('--listen') + 1], '127.0.0.1');
    assert.ok(options.env!.HF_HOME!.startsWith(f.root));
    launchedInstanceId = options.env!.MIXCAT_COMFY_INSTANCE_ID;
    const port = args[args.indexOf('--port') + 1];
    return spawn(process.execPath, [resolve('tests/fixtures/comfy-runtime-server.cjs'), port], options);
  } });
  t.after(() => runtime.stop());
  const [first, concurrent] = await Promise.all([runtime.start(f.root, f.manifest), runtime.start(f.root, f.manifest)]);
  assert.deepEqual(first, concurrent);
  assert.equal(launchedInstanceId, first.instanceId);
  assert.ok(first.pid > 0);
  assert.equal((await runtime.health()).healthy, true);
  await fetch(first.origin + '/test/busy');
  await assert.rejects(runtime.stop(), /未完成任务/);
  assert.equal((await runtime.health()).healthy, true);
  await fetch(first.origin + '/test/idle');
  assert.deepEqual(await runtime.start(f.root, f.manifest), first);
  await runtime.stop();
  assert.equal((await runtime.health()).healthy, false);
  const second = await runtime.start(f.root, f.manifest);
  assert.notEqual(second.instanceId, first.instanceId);
});

test('unexpected backend exit reports only its captured native instance and normal stop does not report loss', async t => {
  const f = fixture(); let child: ReturnType<typeof spawn>; const lost: string[] = [];
  const runtime = new ComfyRuntime({ preparationIO: f.io, onExit: instanceId => { lost.push(instanceId); }, spawn: (_python, args, options) => child = spawn(process.execPath, [resolve('tests/fixtures/comfy-runtime-server.cjs'), args[args.indexOf('--port') + 1]], options) });
  t.after(() => runtime.stop()); const first = await runtime.start(f.root, f.manifest);
  const staleExit = child!.listeners('close');
  child!.kill(); await new Promise(done => child!.once('close', done));
  assert.deepEqual(lost, [first.instanceId]);
  const second = await runtime.start(f.root, f.manifest);
  for (const callback of staleExit) callback(0, null);
  assert.equal((await runtime.health()).instanceId, second.instanceId);
  await runtime.stop(); assert.deepEqual(lost, [first.instanceId]);
});

test('an occupied port fails without adopting or terminating its foreign server', async t => {
  const f = fixture(), foreign = createServer((_req, res) => res.end('foreign server'));
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => foreign.close(() => resolve())));
  const port = (foreign.address() as { port: number }).port;
  const runtime = new ComfyRuntime({ port, preparationIO: f.io, spawn: () => { throw new Error('must never spawn'); } });
  await assert.rejects(runtime.start(f.root, f.manifest), /EADDRINUSE|占用/);
  await runtime.stop();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign server');
});

test('a nested output junction cannot redirect backend writes outside its project', async () => {
  const f = fixture(), outside = fixture();
  const output = projectDirectory(f.root, '.mixcat', 'comfy', 'data', 'output');
  symlinkSync(outside.root, join(output, 'escape'), 'junction');
  const runtime = new ComfyRuntime({ preparationIO: f.io, spawn: () => { throw new Error('must never spawn'); } });
  try { await assert.rejects(runtime.start(f.root, f.manifest), /符号链接|目录联接/); }
  finally { unlinkSync(join(output, 'escape')); }
});

test('a mismatched frontend or early process failure is not accepted as a healthy runtime', async () => {
  const f = fixture();
  const runtime = new ComfyRuntime({ preparationIO: f.io, startupTimeoutMs: 800, spawn: (_python, args, options) => {
    const port = args[args.indexOf('--port') + 1];
    return spawn(process.execPath, [resolve('tests/fixtures/comfy-runtime-server.cjs'), port], { ...options, env: { ...options.env, FIXTURE_BAD_FRONTEND: '1' } });
  } });
  await assert.rejects(runtime.start(f.root, f.manifest), /健康检查超时/);
  assert.equal((await runtime.health()).healthy, false);
  assert.equal(existsSync(join(f.root, '.mixcat', 'comfy', 'instance.lock')), false);
  const failed = new ComfyRuntime({ preparationIO: f.io, spawn: (_python, _args, options) => spawn(process.execPath, ['-e', 'process.exit(5)'], options) });
  await assert.rejects(failed.start(f.root, f.manifest), /启动期间退出/);
  assert.equal(existsSync(join(f.root, '.mixcat', 'comfy', 'instance.lock')), false);
});

test('stopping an idle runtime closes its owned descendants while an unrelated listener stays alive', async t => {
  const f = fixture();
  const foreign=createServer((_req,res)=>res.end('unrelated'));
  await new Promise<void>(resolve=>foreign.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>foreign.close(()=>resolve())));
  const runtime = new ComfyRuntime({ preparationIO: f.io, spawn: (_python,args,options) => {
    const port=args[args.indexOf('--port')+1];
    return spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(resolve('tests/fixtures/comfy-runtime-server.cjs'))},${JSON.stringify(port)}],{stdio:'inherit',detached:true,windowsHide:true});child.once('exit',code=>process.exit(code??1));`],options);
  } });
  const instance=await runtime.start(f.root,f.manifest);
  const {pid}=await (await fetch(instance.origin+'/fixture-pid')).json() as {pid:number};
  const stopping=runtime.stop();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([stopping,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('owned interpreter was orphaned')),3000);})]);
    await assert.rejects(fetch(instance.origin+'/system_stats'));
    assert.throws(()=>process.kill(instance.pid,0),{code:'ESRCH'});
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.equal(await (await fetch(`http://127.0.0.1:${(foreign.address() as {port:number}).port}`)).text(),'unrelated');
  } finally { clearTimeout(timeout); try { process.kill(pid); } catch {} await stopping; }
});

test('failed tree shutdown retains ownership and blocks new starts until it is verified', async () => {
  const f=fixture();
  const runtime=new ComfyRuntime({ preparationIO:f.io, stopProcessTree:async()=>{throw new Error('tree shutdown failed');}, spawn:(_python,args,options)=>spawn(process.execPath,[resolve('tests/fixtures/comfy-runtime-server.cjs'),args[args.indexOf('--port')+1]],options) });
  const instance=await runtime.start(f.root,f.manifest);
  try {
    await assert.rejects(runtime.stop(),/tree shutdown failed/);
    assert.equal(existsSync(join(f.root,'.mixcat','comfy','instance.lock')),true);
    await assert.rejects(runtime.start(f.root,f.manifest),/停止/);
    assert.equal(await (await fetch(instance.origin+'/fixture-pid')).json().then(body=>(body as {pid:number}).pid),instance.pid);
  } finally { try { process.kill(instance.pid); } catch {} }
});

test('spawn keeps OS/network/TLS settings, excludes host credentials and uses the owned backend cwd', async () => {
  const f=fixture();
  const keys=['OPENAI_API_KEY','ARK_API_KEY','MINIMAX_API_KEY','VIDU_API_KEY','AWS_SECRET_ACCESS_KEY','UNRELATED_HOST_SECRET','SSL_CERT_FILE'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys) process.env[key]=key==='SSL_CERT_FILE'?join(f.root,'test-ca.pem'):'mixcat-fixture-only-credential';
  const runtime=new ComfyRuntime({preparationIO:f.io,spawn:(_python,args,options)=>{
    for(const key of keys.filter(key=>key!=='SSL_CERT_FILE')) assert.equal(options.env![key],undefined);
    assert.equal(options.env!.SSL_CERT_FILE===process.env.SSL_CERT_FILE,true);
    assert.equal(options.env!.HTTPS_PROXY===process.env.HTTPS_PROXY,true);
    assert.equal(options.env!.SystemRoot===process.env.SystemRoot,true);
    assert.ok(options.env!.NO_PROXY!.includes('127.0.0.1'));
    assert.equal(options.cwd,join(f.root,'.mixcat','comfy','runtime',f.manifest.id,'backend'));
    return spawn(process.execPath,[resolve('tests/fixtures/comfy-runtime-server.cjs'),args[args.indexOf('--port')+1]],options);
  }});
  try { await runtime.start(f.root,f.manifest); }
  finally {
    try { await runtime.stop(); }
    finally { for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;} }
  }
});

test('an unusable project log directory fails before spawning a backend process', async () => {
  const f=fixture();
  let spawned=false;
  const runtime=new ComfyRuntime({ preparationIO:{...f.io,install:async(prepared,downloads)=>{await f.io.install(prepared,downloads);writeFileSync(join(f.root,'.mixcat','comfy','logs'),'not a directory');}}, spawn:()=>{spawned=true;throw new Error('must not spawn');} });
  await assert.rejects(runtime.start(f.root,f.manifest),/EEXIST|ENOTDIR/);
  assert.equal(spawned,false);
});

test('production installation resumes incomplete Git checkouts and reuses a complete checkout', async t => {
  for (const state of ['missing-commit', 'missing-blob', 'complete']) await t.test(state, async () => {
  const f = fixture(), source = projectDirectory(f.root, 'source');
  const git = (args: string[]) => execFileSync('git', args, { cwd: f.root, env: runtimeEnvironment(f.root), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--object-format=sha1', source]);
  writeFileSync(join(source, 'main.py'), '# real Git fixture backend\n');
  writeFileSync(join(source, 'LICENSE'), 'fixture license\n');
  git(['-C', source, 'add', '.']);
  git(['-C', source, '-c', 'user.name=Mixcat Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-m', 'fixture']);
  f.manifest.backend.commit = git(['-C', source, 'rev-parse', 'HEAD']).trim();
  const backend = projectDirectory(f.root, '.mixcat', 'comfy', 'runtime', f.manifest.id, 'backend');
  if (state === 'missing-commit') {
    git(['init', '--object-format=sha1', backend]);
    writeFileSync(join(backend, 'partial-download.txt'), 'interrupted unpublished clone');
  } else {
    git(['clone', '--no-hardlinks', '--no-checkout', source, backend]);
    if (state === 'missing-blob') {
      const blob = git(['-C', source, 'rev-parse', `${f.manifest.backend.commit}:main.py`]).trim();
      unlinkSync(join(backend, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    }
  }
  const output = join(projectDirectory(f.root, '.mixcat', 'comfy', 'data', 'output'), 'keep.txt');
  const model = join(projectDirectory(f.root, '.mixcat', 'comfy', 'data', 'models'), 'keep.bin');
  writeFileSync(output, 'user output'); writeFileSync(model, 'user model');
  const savedSource = process.env.MIXCAT_COMFY_BACKEND_SOURCE;
  process.env.MIXCAT_COMFY_BACKEND_SOURCE = state === 'complete' ? join(f.root, 'unavailable-source') : source;
  try {
    const prepared = await prepareRuntime(f.root, f.manifest, { download: f.io.download, install: (prepared, downloads) => installRuntime(prepared, downloads, async (executable, args) => {
      if (executable === 'git') return git(args);
      if (args[0] === '-m' && args[1] === 'venv') writeFileSync(join(args[2], 'Scripts', 'python.exe'), 'fixture interpreter');
      else assert.ok(executable === 'tar.exe' || executable.endsWith('python.exe'));
      return '';
    }) });
    assert.equal(existsSync(join(prepared.directory, 'ready.json')), true);
    assert.equal(git(['-C', prepared.backend, 'rev-parse', 'HEAD']).trim(), f.manifest.backend.commit);
    assert.equal(git(['-C', prepared.backend, 'remote', 'get-url', 'origin']).trim(), f.manifest.backend.repository);
    assert.equal(readFileSync(join(prepared.backend, 'main.py'), 'utf8').replaceAll('\r\n', '\n'), '# real Git fixture backend\n');
    assert.equal(readFileSync(output, 'utf8'), 'user output'); assert.equal(readFileSync(model, 'utf8'), 'user model');
    assert.equal(git(['-C', source, 'status', '--porcelain']).trim(), '');
  } finally {
    if (savedSource === undefined) delete process.env.MIXCAT_COMFY_BACKEND_SOURCE; else process.env.MIXCAT_COMFY_BACKEND_SOURCE = savedSource;
  }
  });
});
