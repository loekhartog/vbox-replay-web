import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, baseConfig } from './views.mjs';
import { routes } from './routes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const PORT = Number(process.env.PORT || 8788);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.delta': 'application/octet-stream', '.mp4': 'video/mp4' };

export function sendStatic(res, file, headers = {}, req = null) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  const type = MIME[ext] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400', ...headers };
  const range = req?.headers?.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    // HTTP range requests: required for <video> seeking
    let start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
    if (start >= size || end >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true; }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res); return true;
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  if (req?.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res); return true;
}
export const json = (res, body, status = 200) => { const s = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' }); res.end(s); };
export const html = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
export const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
export const api = (data, code = 200, meta = []) => ({ code, messages: [], data, meta });

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ _raw: raw }); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ctx = { req, res, url, pathname: decodeURIComponent(url.pathname), query: url.searchParams, body: null, render, baseConfig, json, html, redirect, api, sendStatic, root };
  if (process.env.LOG !== '0') console.log(new Date().toISOString().slice(11,19), req.method, req.url);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readBody(req);
    for (const r of routes) {
      const m = r.match(ctx);
      if (m) { await r.handle(ctx, m); return; }
    }
    const file = path.join(PUBLIC, path.normalize(ctx.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(PUBLIC) && sendStatic(res, file, {}, req)) return;
    html(res, render('404', { user: ctx.user }), 404);
  } catch (e) {
    console.error(req.method, req.url, e);
    if (!res.headersSent) html(res, '<pre>' + String(e && e.stack || e) + '</pre>', 500);
  }
});
server.listen(PORT, () => console.log(`Telemetry web client → http://localhost:${PORT}`));
