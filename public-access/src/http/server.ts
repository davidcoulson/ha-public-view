import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { Config, Publication } from '../config.ts';
import type { Viewer } from '../core/viewer.ts';
import type { PublicationStore } from '../publications.ts';
import { RateLimiter, SessionLimiter, visitorAddress } from './guard.ts';
import { log } from '../log.ts';
import type { PublishedProvider } from '../policy/published.ts';
import { Session, stats } from '../relay/session.ts';
import { AssetCache, isStaticPath } from './assets.ts';
import { renderIndex, SELF_REMOVING_SERVICE_WORKER } from './page.ts';
import { historyPeriod } from './history.ts';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The page may not be framed by other sites, and may not load plugins or rebase URLs.
  'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'",
};

/** Publication for a request: by Host header, or the only one when there is just one. */
export function publicationFor(pubs: Publication[], host: string | undefined, forwardedHost?: string): Publication | undefined {
  if (pubs.length === 1) return pubs[0];
  const h = (forwardedHost ?? host ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  return pubs.find((p) => p.hostname === h);
}

export function createServer(config: Config, viewer: Viewer, store: PublicationStore, providerFor: (pub: Publication) => PublishedProvider) {
  const assets = new AssetCache(config.haUrl);
  const pages = new RateLimiter(config.limits.requestsPerMinute);
  const statics = new RateLimiter(config.limits.staticPerMinute);
  const sessions = new SessionLimiter(config.limits.maxSessions, config.limits.maxSessionsPerVisitor);
  let indexCache: { at: number; html: string } | undefined;

  async function coreIndex(): Promise<string> {
    if (indexCache && Date.now() - indexCache.at < 60_000) return indexCache.html;
    const r = await fetch(`${config.haUrl}/`, { redirect: 'manual' });
    if (!r.ok) throw new Error(`Core index page answered ${r.status}`);
    indexCache = { at: Date.now(), html: await r.text() };
    return indexCache.html;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
      const pub = publicationFor(store.list(), req.headers.host, req.headers['x-forwarded-host'] as string | undefined);
      if (!pub) return send(404, 'Not found');
      const visitor = visitorAddress(req.socket.remoteAddress, req.headers);

      if (path === '/healthz') return send(200, JSON.stringify({ status: 'ok', visitors: sessions.active, ...stats }), { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (path === '/robots.txt') return send(200, pub.noindex ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' });
      if (path === '/sw-modern.js' || path === '/sw-legacy.js') {
        return send(200, SELF_REMOVING_SERVICE_WORKER, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      }
      if (isStaticPath(path)) {
        if (!statics.allow(visitor)) return send(429, 'Too many requests', { 'retry-after': '60' });
        const a = await assets.get(req.url!);
        return send(a.status, a.body, a.headers);
      }
      if (path === '/api/history/period' || path.startsWith('/api/history/period/')) {
        if (!pages.allow(visitor)) return send(429, 'Too many requests', { 'retry-after': '60' });
        const published = await providerFor(pub).get();
        const out = await historyPeriod(config.haUrl, await viewer.accessToken(), published, path, url.searchParams);
        return send(out.status, JSON.stringify(out.body), { 'content-type': 'application/json', 'cache-control': 'no-store' });
      }
      if (!/\.[a-z0-9]+$/i.test(path) && !path.startsWith('/api/') && !path.startsWith('/auth/')) {
        if (!pages.allow(visitor)) return send(429, 'Too many requests', { 'retry-after': '60' });
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
        if (pub.noindex) headers['x-robots-tag'] = 'noindex, nofollow';
        return send(200, renderIndex(await coreIndex(), pub), headers);
      }
      log.debug(`404 ${path}`);
      return send(404, 'Not found');
    } catch (e) {
      log.warn(`request failed: ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(502, SECURITY_HEADERS);
      res.end('Upstream error');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const pub = publicationFor(store.list(), req.headers.host, req.headers['x-forwarded-host'] as string | undefined);
    if (!pub || (req.url ?? '').split('?')[0] !== '/api/websocket') { socket.destroy(); return; }
    const visitor = visitorAddress(req.socket.remoteAddress, req.headers);
    const refuse = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nRetry-After: 30\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!pages.allow(visitor)) return refuse('429 Too Many Requests');
    const release = sessions.acquire(visitor);
    if (!release) return refuse('503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => {
      new Session(ws, pub, providerFor(pub), viewer, config.haUrl, config.limits.messagesPer10s, release);
    });
  });
  return server;
}
