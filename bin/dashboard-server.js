/**
 * `sm dashboard` — the original stand-alone dashboard (dashboard/index.html + office.js).
 * The main UI now lives inside the Pixel Office fork (`sm office`); both read the same sm-api.js.
 * Binds to 127.0.0.1; writes require an `X-SM: 1` header, which browsers won't send cross-origin
 * without a CORS preflight we never grant.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createApi } = require('./sm-api.js');

function start({ port = 4321, sm, 'no-open': noOpen }) {
  const { ROOT } = sm;
  const api = createApi(sm);
  const html = path.join(ROOT, 'dashboard', 'index.html');
  // Pixel Agents' art (MIT; characters based on JIK-A-4's Metro City pack) is served straight from
  // the user's own install — nothing is copied into this repo.
  let pxRoot = null;
  try {
    const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    if (fs.existsSync(path.join(g, 'pixel-agents', 'dist', 'assets'))) pxRoot = path.join(g, 'pixel-agents', 'dist');
  } catch {}
  const MIME = { '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf' };
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  function serveStatic(res, base, rel) {
    const full = path.resolve(base || '/nonexistent', rel);
    if (!base || !full.startsWith(base + path.sep) || !MIME[path.extname(full)] || !fs.existsSync(full)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)], 'Cache-Control': 'max-age=3600' });
    fs.createReadStream(full).pipe(res);
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { d = ''; req.removeAllListeners('data'); req.resume(); reject(Object.assign(new Error('request too large'), { status: 413 })); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
  // Anti DNS-rebinding: a page on evil.example that re-points its name at 127.0.0.1 is "same origin" and could
  // send X-SM and start agents. Only requests addressed to this machine by a loopback name are served.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const server = http.createServer(async (req, res) => {
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'unknown host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, fs.readFileSync(html), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/office.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(ROOT, 'dashboard', 'office.js'))); }
      if (req.method === 'GET' && url.pathname.startsWith('/px/')) return serveStatic(res, pxRoot && path.join(pxRoot, 'assets'), decodeURIComponent(url.pathname.slice(4)));
      if (req.method === 'GET' && url.pathname.startsWith('/pxfont/')) return serveStatic(res, pxRoot && path.join(pxRoot, 'webview', 'fonts'), decodeURIComponent(url.pathname.slice(8)));
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, api.projects());
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, api.health());
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, api.state(url.searchParams.get('project')));
      if (req.method === 'GET' && url.pathname === '/api/diff') return send(res, 200, { diff: api.diff(url.searchParams.get('project')) });
      if (req.method === 'POST') {
        if (req.headers['x-sm'] !== '1') return send(res, 403, { error: 'missing X-SM header' });
        const body = await readBody(req);
        if (url.pathname === '/api/audit') return send(res, 200, api.audit(body));
        if (url.pathname === '/api/fix') return send(res, 200, api.fix(body));
        if (url.pathname === '/api/human') return send(res, 200, api.human(body));
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  server.listen(Number(port), '127.0.0.1', () => {
    const link = `http://127.0.0.1:${port}/`;
    console.log(`🛰  ARES-I command center: ${link}  (Ctrl+C to stop)`);
    if (process.platform === 'darwin' && !noOpen) spawn('open', [link], { stdio: 'ignore', detached: true }).unref();
  });
}

module.exports = { start };
