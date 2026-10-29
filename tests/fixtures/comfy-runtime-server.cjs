const http = require('node:http');
const port = Number(process.argv[2]);
let busy = false;
http.createServer((req, res) => {
  if (req.url === '/test/busy') busy = true;
  if (req.url === '/test/idle') busy = false;
  const body = {
    '/system_stats': { system: { comfyui_version: '0.43.0', required_frontend_version: process.env.FIXTURE_BAD_FRONTEND ? '1.0.0' : '1.57.4', python_version: '3.14.10' } },
    '/object_info': { KSampler: {}, SaveImage: {}, EmptyLatentImage: {}, CheckpointLoaderSimple: {} },
    '/extensions': [],
    '/fixture-pid': { pid: process.pid },
    '/queue': { queue_running: busy ? [[1, 'owned-prompt']] : [], queue_pending: [] }
  }[req.url];
  res.setHeader('Content-Type', body ? 'application/json' : req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(body ? JSON.stringify(body) : req.url === '/' ? '<html><script type="module" src="/assets/app.js"></script></html>' : 'export const native = true;');
}).listen(port, '127.0.0.1', () => console.log(`To see the GUI go to: http://127.0.0.1:${port}`));
