import { loadConfig, type Publication } from './config.ts';
import { Viewer } from './core/viewer.ts';
import { startEsphome } from './esphome/host.ts';
import { startHealthProbe } from './health.ts';
import { createServer } from './http/server.ts';
import { createUiServer } from './ui/server.ts';
import { log, setLogLevel } from './log.ts';
import { PublishedProvider } from './policy/published.ts';
import { PublicationStore } from './publications.ts';
import { disconnectAll, stats, visitorsByHost } from './relay/session.ts';
import { Settings, type LogLevelName } from './settings.ts';

const VERSION = '0.2.0';
const config = loadConfig();
setLogLevel(config.logLevel);

async function waitForCore(): Promise<void> {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${config.haUrl}/manifest.json`)).ok) return; } catch { /* not up yet */ }
    if (i % 10 === 0) log.info(`Waiting for Home Assistant at ${config.haUrl}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await waitForCore();
const viewer = new Viewer(config);
await viewer.ensure();
const store = await PublicationStore.load(config.dataDir, config.publications);
const settings = await Settings.load(config.dataDir, {
  paused: false,
  maxSessions: config.limits.maxSessions,
  maxSessionsPerVisitor: config.limits.maxSessionsPerVisitor,
  logLevel: (['debug', 'info', 'warn', 'error'].includes(config.logLevel ?? '') ? config.logLevel : 'info') as LogLevelName,
});
setLogLevel(settings.data.logLevel);

// One provider per (dashboard, view), created on first use, dropped when no publication uses it any more.
const providers = new Map<string, PublishedProvider>();
const key = (p: Publication) => `${p.dashboard}\u0000${p.view}`;
const providerFor = (p: Publication): PublishedProvider => {
  let provider = providers.get(key(p));
  if (!provider) { provider = new PublishedProvider(p, config.haUrl, viewer); providers.set(key(p), provider); }
  return provider;
};
store.onChange(() => {
  const live = new Set(store.list().map(key));
  for (const k of providers.keys()) if (!live.has(k)) providers.delete(k);
});

const health = startHealthProbe(config, viewer);
await health.probe();

// Entities visible across the enabled publications, refreshed in the background for the ESPHome sensor.
let publishedCount = 0;
const refreshCount = async () => {
  const sets = await Promise.all(store.list().filter((p) => p.enabled !== false).map((p) => providerFor(p).get()));
  publishedCount = new Set(sets.flatMap((p) => [...p.entities])).size;
};
void refreshCount();
setInterval(() => void refreshCount(), 30_000).unref();

const server = createServer(config, viewer, store, settings, providerFor);
server.listen(config.port, () => {
  const list = store.list();
  log.info(list.length ? `Listening on :${config.port} for ${list.map((p) => `${p.hostname} -> ${p.dashboard}/${p.view}`).join(', ')}` : `Listening on :${config.port}; nothing is published yet. Add a publication in the Public Access panel.`);
});

const esphome = config.esphome.enabled
  ? await startEsphome(config, {
      settings, store, stats,
      visitorsByHost,
      disconnectAll,
      health: () => health.get(),
      publishedEntities: () => publishedCount,
      refreshViews: () => { providers.forEach((p) => p.invalidate()); void refreshCount(); },
      setLogLevel,
    }, VERSION)
  : undefined;

const ui = config.uiPort ? createUiServer(config, viewer, store, providerFor, esphome) : undefined;
ui?.listen(config.uiPort, () => log.info(`Setup page on :${config.uiPort}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void esphome?.stop(); ui?.close(); server.close(() => process.exit(0)); });
