import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config, Publication } from '../config.ts';
import { adminSocket } from '../core/admin.ts';
import type { Viewer } from '../core/viewer.ts';
import { log } from '../log.ts';
import { PublishedProvider } from '../policy/published.ts';
import { PublicationStore, ValidationError, validatePublications } from '../publications.ts';
import { stats } from '../relay/session.ts';

const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');

interface DashboardInfo {
  dashboard: string;
  title: string;
  note?: string;
  views: Array<{ path: string | null; title: string }>;
}

async function listDashboards(config: Config): Promise<DashboardInfo[]> {
  const admin = await adminSocket(config);
  try {
    const custom = await admin.call<Array<{ url_path: string; title: string }>>('lovelace/dashboards/list');
    const all = [{ url_path: 'lovelace', title: 'Overview (default dashboard)' }, ...custom];
    const out: DashboardInfo[] = [];
    for (const d of all) {
      const cfg = await admin.request('lovelace/config', { url_path: d.url_path === 'lovelace' ? null : d.url_path, force: false });
      if (!cfg.success) {
        out.push({ dashboard: d.url_path, title: d.title, views: [], note: 'This dashboard is generated automatically or uses YAML. Save it once from the dashboard editor to publish it.' });
        continue;
      }
      const views = Array.isArray(cfg.result?.views) ? cfg.result.views : [];
      out.push({
        dashboard: d.url_path,
        title: d.title,
        views: views.map((v: any, i: number) => ({ path: v.path === undefined ? null : String(v.path), title: String(v.title ?? `View ${i + 1}`) })),
        note: cfg.result?.strategy ? 'This dashboard is built by a strategy, so the entities it shows cannot be listed.' : undefined,
      });
    }
    return out;
  } finally {
    admin.close();
  }
}

async function addonHostname(config: Config): Promise<string | null> {
  if (!config.supervisorToken) return null;
  try {
    const r = await fetch('http://supervisor/addons/self/info', { headers: { authorization: `Bearer ${config.supervisorToken}` } });
    return r.ok ? ((await r.json()) as any).data?.hostname ?? null : null;
  } catch { return null; }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ValidationError('Expected JSON');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new ValidationError('Request too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Invalid JSON'); }
}

/**
 * The setup page, served through Home Assistant's ingress. Only the Supervisor may talk to it: ingress
 * has already checked that the user is logged in to Home Assistant as an administrator.
 */
export function createUiServer(config: Config, viewer: Viewer, store: PublicationStore, _providerFor: (p: Publication) => PublishedProvider) {
  return http.createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const peer = req.socket.remoteAddress ?? '';
      if (config.uiAllowedPeers !== 'any' && !config.uiAllowedPeers.includes(peer)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const path = new URL(req.url ?? '/', 'http://x').pathname;

      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(html); return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        return json(200, {
          publications: store.list(),
          visitors: stats.active,
          sessionsSinceStart: stats.sessions,
          publicPort: config.port,
          addonHostname: await addonHostname(config),
        });
      }
      if (req.method === 'GET' && path === '/api/dashboards') return json(200, await listDashboards(config));
      if (req.method === 'POST' && path === '/api/preview') {
        const [pub] = validatePublications([{ ...(await readJson(req) as object), hostname: 'preview.invalid' }]);
        const p = await new PublishedProvider(pub, config.haUrl, viewer).get();
        return json(200, {
          viewFound: p.view !== null,
          entities: [...p.entities].sort(),
          statistics: p.statistics.size,
          templates: p.templates.size,
          devices: p.deviceIds.size,
          areas: p.areaIds.size,
          energy: p.energy,
        });
      }
      if (req.method === 'PUT' && path === '/api/publications') {
        const saved = await store.set(await readJson(req));
        log.info(`Publications saved: ${saved.map((p) => p.hostname).join(', ') || '(none)'}`);
        return json(200, saved);
      }
      json(404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof ValidationError) return json(400, { error: e.message });
      log.warn(`setup page error: ${(e as Error).message}`);
      json(502, { error: 'Could not reach Home Assistant. Check the add-on log.' });
    }
  });
}
