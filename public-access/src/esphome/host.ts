import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Device } from 'esphome-device';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { buildEntities, type Controls } from './entities.ts';

export const DEVICE_NAME = 'public-access';

export interface EsphomeHandle {
  port: number;
  /** Base64 Noise key Home Assistant needs to add the device. */
  key: string;
  connected(): boolean;
  clients(): number;
  stop(): Promise<void>;
}

async function loadKey(dataDir: string): Promise<string> {
  const file = join(dataDir, 'esphome.json');
  try {
    const k = JSON.parse(await readFile(file, 'utf8')).noiseKey;
    if (typeof k === 'string' && Buffer.from(k, 'base64').length === 32) return k;
  } catch { /* first start */ }
  const noiseKey = randomBytes(32).toString('base64');
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ noiseKey }), { mode: 0o600 });
  return noiseKey;
}

/**
 * Runs the ESPHome device. Its entity list is fixed once it starts, so when publications are added or
 * removed the device is stopped and started again; Home Assistant reconnects within a few seconds and
 * keeps the entity ids and history, because they come from stable ids.
 */
export async function startEsphome(config: Config, controls: Controls, version: string): Promise<EsphomeHandle> {
  const key = await loadKey(config.dataDir);
  const port = config.esphome.port;
  let device: Device | undefined;
  let tick: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const build = async () => {
    if (tick) clearInterval(tick);
    await device?.stop().catch(() => undefined);
    if (stopped) return;
    const next = new Device({
      name: DEVICE_NAME,
      friendlyName: 'Public Access',
      noiseKey: key,
      port,
      mdns: false, // multicast does not leave a container; Home Assistant is pointed at the host name
      project: { name: 'ha-public-view.public-access', version },
      manufacturer: 'ha-public-view',
      model: 'Home Assistant add-on',
      log: { info: (m: string) => log.debug(`esphome: ${m}`), warn: (m: string) => log.warn(`esphome: ${m}`) },
    });
    next.on('error', (e: Error) => log.warn(`esphome: ${e.message}`));
    const { update } = buildEntities(next, controls);
    await next.start();
    tick = setInterval(update, 3000);
    device = next;
    log.info(`ESPHome device "${DEVICE_NAME}" listening on :${port} (Noise encrypted)`);
  };
  const queue = () => { chain = chain.then(build).catch((e) => log.warn(`esphome restart failed: ${(e as Error).message}`)); return chain; };

  await queue();
  let debounce: NodeJS.Timeout | undefined;
  // A publication was added or removed: new entities are needed. (Enabling/disabling one keeps the same set.)
  let knownHosts = controls.store.list().map((p) => p.hostname).sort().join('\n');
  controls.store.onChange(() => {
    const hosts = controls.store.list().map((p) => p.hostname).sort().join('\n');
    if (hosts === knownHosts) return;
    knownHosts = hosts;
    clearTimeout(debounce);
    debounce = setTimeout(queue, 500);
  });

  return {
    port,
    key,
    connected: () => device?.connected ?? false,
    clients: () => device?.clients.length ?? 0,
    stop: async () => { stopped = true; clearTimeout(debounce); if (tick) clearInterval(tick); await device?.stop(); },
  };
}
