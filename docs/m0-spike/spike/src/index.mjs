import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ensureAdmin, waitForHa } from './ha.mjs';
import { runChecks } from './checks.mjs';
import { attachRelay, stats, ALLOWED } from './relay.mjs';

const HA_URL = (process.env.HA_URL ?? 'http://homeassistant:8123').replace(/\/$/, '');
const PORT = Number(process.env.PORT ?? 8099);
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin-m0-password';
const bootstrap = readFileSync(fileURLToPath(new URL('./bootstrap.js', import.meta.url)), 'utf8');

const report = { status: 'starting', node: process.version, ha_url: HA_URL, checks: [] };
const requestLog = { unhandled: {} };

// What may be fetched from Home Assistant over plain HTTP. Everything else is a 404 here.
const STATIC_PREFIXES = ['/frontend_latest/', '/static/', '/hacsfiles/', '/local/'];
const PASS_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified'];

let indexCache = { at: 0, html: '' };
async function indexHtml() {
  if (Date.now() - indexCache.at < 60000) return indexCache.html;
  const r = await fetch(`${HA_URL}/`, { redirect: 'manual' });
  if (!r.ok) throw new Error(`index fetch: ${r.status}`);
  let html = await r.text();
  html = html.replace(/<head[^>]*>/i, (m) => `${m}<script>${bootstrap}</script>`);
  indexCache = { at: Date.now(), html };
  return html;
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (path === '/m0/results') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...report, relay: stats, allowed: [...ALLOWED], other_requests_refused: requestLog.unhandled }, null, 2));
      return;
    }
    if (STATIC_PREFIXES.some((p) => path.startsWith(p))) {
      const up = await fetch(`${HA_URL}${req.url}`, { redirect: 'manual' });
      const headers = {};
      for (const h of PASS_HEADERS) if (up.headers.get(h)) headers[h] = up.headers.get(h);
      res.writeHead(up.status, headers);
      if (up.body) Readable.fromWeb(up.body).pipe(res); else res.end();
      return;
    }
    const hasExtension = /\.[a-z0-9]+$/i.test(path);
    if (!hasExtension && !path.startsWith('/api/') && !path.startsWith('/auth/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await indexHtml());
      return;
    }
    requestLog.unhandled[path] = (requestLog.unhandled[path] ?? 0) + 1;
    res.writeHead(404).end('Not found');
  } catch (e) {
    console.error('request error', path, e.message);
    res.writeHead(502).end('Upstream error');
  }
});

server.listen(PORT, () => console.log(`spike listening on :${PORT}`));

(async () => {
  await waitForHa(HA_URL);
  console.log('Home Assistant is up; onboarding and logging in as admin');
  const tokens = await ensureAdmin(HA_URL, ADMIN_USER, ADMIN_PASS);
  report.status = 'running checks';
  const { results, viewer } = await runChecks(HA_URL, tokens);
  report.checks = results;
  for (const r of results) {
    const mark = r.ok === null ? 'info' : r.ok ? ' ok ' : 'FAIL';
    console.log(`[${mark}] ${r.id}  ${r.title}\n        ${r.detail}`);
  }
  if (!viewer) { report.status = 'checks failed before a viewer existed; relay not started'; return; }
  attachRelay(server, { haUrl: HA_URL, viewerRefreshToken: viewer.refreshToken });
  report.status = 'ready';
  console.log(`\nReady. Open http://localhost:${PORT}/lovelace/0   (results: /m0/results)`);
})().catch((e) => { report.status = `error: ${e.message}`; console.error(e); });
