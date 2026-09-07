import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Serve the same assembled assets as deployment, with the existing dev API.
const root = path.resolve(fileURLToPath(new URL('../../infra/worker/public/', import.meta.url)));
const upstream = new URL(process.env.PREVIEW_API || 'https://dev.myheliograph.com');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    let file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' || req.method === 'HEAD') {
      for (const candidate of [file, path.join(file, 'index.html'), file + '.html']) {
        const info = await stat(candidate).catch(() => null);
        if (!info?.isFile()) continue;
        res.writeHead(200, { 'Content-Type': types[path.extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else createReadStream(candidate).pipe(res);
        return;
      }
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/asset/')) {
      const headers = { ...req.headers, host: upstream.host, origin: upstream.origin, referer: upstream.origin + '/' };
      delete headers.cookie;
      const proxy = https.request(new URL(url.pathname + url.search, upstream), { method: req.method, headers, timeout: 30000 }, (reply) => {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy(new Error('Dev API timed out')));
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Dev API unavailable. Retry when it is reachable.' })); });
      req.pipe(proxy);
      return;
    }
    res.writeHead(404).end('Not found');
  } catch {
    res.writeHead(400).end('Bad request');
  }
});
server.listen(4173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4173\nAPI: ' + upstream.origin));
