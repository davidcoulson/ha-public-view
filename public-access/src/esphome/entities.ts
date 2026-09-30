import type { Device } from 'esphome-device';
import type { PublicationStore } from '../publications.ts';
import { LOG_LEVELS, type LogLevelName, type Settings } from '../settings.ts';

/** What the device needs from the rest of the app. Kept narrow so it can be tested with a fake device. */
export interface Controls {
  settings: Settings;
  store: PublicationStore;
  stats: { active: number; sessions: number; refusedTotal: number; rateLimited: number };
  visitorsByHost(): Map<string, number>;
  disconnectAll(reason: string): number;
  health(): { core: boolean; message: string };
  /** Entities visible to visitors across enabled publications (cached; refreshed in the background). */
  publishedEntities(): number;
  refreshViews(): void;
  setLogLevel(level: LogLevelName): void;
}

export const slug = (hostname: string): string => hostname.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Declares everything Home Assistant sees. Monitoring is read-only sensors; configuration is switches,
 * numbers, a select and buttons that change running settings. Returns `update`, to be called regularly.
 */
export function buildEntities(dev: Device, c: Controls): { update(): void } {
  const s = c.settings;

  // ---- configuration
  const serve = dev.switch({ name: 'Serve visitors', id: 'serve_visitors', icon: 'mdi:eye', category: 'config', state: !s.data.paused }, async (on) => {
    await s.update({ paused: !on });
    if (!on) c.disconnectAll('paused by owner');
  });
  const maxVisitors = dev.number({ name: 'Most visitors', id: 'max_visitors', icon: 'mdi:account-group', category: 'config', min: 1, max: 500, step: 1, mode: 'box', state: s.data.maxSessions }, async (v) => {
    await s.update({ maxSessions: v });
    return s.data.maxSessions;
  });
  const maxPer = dev.number({ name: 'Most connections per visitor', id: 'max_per_visitor', icon: 'mdi:account', category: 'config', min: 1, max: 50, step: 1, mode: 'box', state: s.data.maxSessionsPerVisitor }, async (v) => {
    await s.update({ maxSessionsPerVisitor: v });
    return s.data.maxSessionsPerVisitor;
  });
  const level = dev.select({ name: 'Log level', id: 'log_level', icon: 'mdi:text-box-search', category: 'config', options: [...LOG_LEVELS], state: s.data.logLevel }, async (v) => {
    await s.update({ logLevel: v as LogLevelName });
    c.setLogLevel(s.data.logLevel);
  });
  dev.button({ name: 'Disconnect all visitors', id: 'disconnect_visitors', icon: 'mdi:account-off', category: 'config' }, () => { c.disconnectAll('disconnected by owner'); });
  dev.button({ name: 'Reload published view', id: 'reload_view', icon: 'mdi:refresh', category: 'config' }, () => { c.refreshViews(); });

  // ---- monitoring
  const status = dev.textSensor({ name: 'Status', id: 'status', icon: 'mdi:information-outline' });
  const core = dev.binarySensor({ name: 'Home Assistant link', id: 'core_link', deviceClass: 'connectivity', category: 'diagnostic' });
  const visitors = dev.sensor({ name: 'Visitors', id: 'visitors', icon: 'mdi:account-multiple', stateClass: 'measurement', accuracyDecimals: 0 });
  const visits = dev.sensor({ name: 'Visits', id: 'visits', icon: 'mdi:counter', stateClass: 'total_increasing', accuracyDecimals: 0 });
  const refused = dev.sensor({ name: 'Refused requests', id: 'refused_requests', icon: 'mdi:shield-alert-outline', stateClass: 'total_increasing', accuracyDecimals: 0, category: 'diagnostic' });
  const limited = dev.sensor({ name: 'Rate limited', id: 'rate_limited', icon: 'mdi:speedometer-slow', stateClass: 'total_increasing', accuracyDecimals: 0, category: 'diagnostic' });
  const published = dev.sensor({ name: 'Published entities', id: 'published_entities', icon: 'mdi:eye-check', stateClass: 'measurement', accuracyDecimals: 0, category: 'diagnostic' });

  // ---- one switch and one counter per publication
  const pubs = c.store.list();
  const perPub = pubs.map((p) => {
    const id = slug(p.hostname);
    const sw = dev.switch({ name: `Publish ${p.hostname}`, id: `publish_${id}`, icon: 'mdi:earth', category: 'config', state: p.enabled !== false }, async (on) => {
      await c.store.set(c.store.list().map((x) => (x.hostname === p.hostname ? { ...x, enabled: on } : x)));
    });
    const count = dev.sensor({ name: `Visitors on ${p.hostname}`, id: `visitors_${id}`, icon: 'mdi:account-multiple', stateClass: 'measurement', accuracyDecimals: 0 });
    return { hostname: p.hostname, sw, count };
  });

  const syncConfig = () => {
    serve.set(!s.data.paused);
    maxVisitors.set(s.data.maxSessions);
    maxPer.set(s.data.maxSessionsPerVisitor);
    level.set(s.data.logLevel);
  };
  s.on('change', syncConfig);

  const update = () => {
    const h = c.health();
    const enabled = c.store.list().filter((p) => p.enabled !== false).length;
    status.set(
      s.data.paused ? 'Paused'
        : !h.core ? `Waiting for Home Assistant: ${h.message}`
        : enabled === 0 ? 'Nothing published'
        : `Serving ${enabled} ${enabled === 1 ? 'publication' : 'publications'}`,
    );
    core.set(h.core);
    visitors.set(c.stats.active);
    visits.set(c.stats.sessions);
    refused.set(c.stats.refusedTotal);
    limited.set(c.stats.rateLimited);
    published.set(c.publishedEntities());
    const by = c.visitorsByHost();
    for (const p of perPub) p.count.set(by.get(p.hostname) ?? 0);
    syncConfig();
  };
  update();
  return { update };
}
