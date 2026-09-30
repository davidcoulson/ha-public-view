import { loadConfig, type Publication } from './config.ts';
import { Viewer } from './core/viewer.ts';
import { createServer } from './http/server.ts';
import { createUiServer } from './ui/server.ts';
import { log, setLogLevel } from './log.ts';
import { PublishedProvider } from './policy/published.ts';
import { PublicationStore } from './publications.ts';

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

const server = createServer(config, viewer, store, providerFor);
server.listen(config.port, () => {
  const list = store.list();
  log.info(list.length ? `Listening on :${config.port} for ${list.map((p) => `${p.hostname} -> ${p.dashboard}/${p.view}`).join(', ')}` : `Listening on :${config.port}; nothing is published yet. Add a publication in the Public Access panel.`);
});
const ui = config.uiPort ? createUiServer(config, viewer, store, providerFor) : undefined;
ui?.listen(config.uiPort, () => log.info(`Setup page on :${config.uiPort}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { ui?.close(); server.close(() => process.exit(0)); });
