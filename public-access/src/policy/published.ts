import type { Publication } from '../config.ts';
import { HaSocket, wsUrl } from '../core/client.ts';
import type { Viewer } from '../core/viewer.ts';
import { log } from '../log.ts';
import { pickView, scanView, type LovelaceView } from './scan.ts';

/** Everything a visitor may touch for one publication. Anything not in here is refused or hidden. */
export interface Published {
  view: LovelaceView | null;
  entities: Set<string>;
  statistics: Set<string>;
  templates: Set<string>;
  energy: boolean;
  deviceIds: Set<string>;
  areaIds: Set<string>;
  floorIds: Set<string>;
  labelIds: Set<string>;
  domains: Set<string>;
}

export const EMPTY: Published = {
  view: null, entities: new Set(), statistics: new Set(), templates: new Set(), energy: false,
  deviceIds: new Set(), areaIds: new Set(), floorIds: new Set(), labelIds: new Set(), domains: new Set(),
};

const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const STATISTIC = /^[a-z0-9_]+:[a-z0-9_]+$/;
const TTL_MS = 30_000;

interface EntityEntry { entity_id: string; device_id?: string | null; area_id?: string | null; labels?: string[] }
interface Device { id: string; area_id?: string | null; labels?: string[] }
interface Area { area_id: string; floor_id?: string | null; labels?: string[] }

function collectIds(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') { if (ENTITY.test(value) || STATISTIC.test(value)) into.add(value); }
  else if (Array.isArray(value)) value.forEach((v) => collectIds(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectIds(v, into));
}

/** Pure part of the computation, separated so it can be tested without Core. */
export function computePublished(input: {
  view: LovelaceView | null;
  registry: EntityEntry[];
  devices: Device[];
  areas: Area[];
  floorIds: string[];
  labelIds: string[];
  energyPrefs?: unknown;
}): Published {
  if (!input.view) return { ...EMPTY };
  const scan = scanView(input.view);
  const entities = new Set(scan.entities);
  const statistics = new Set([...scan.statistics, ...scan.entities]);
  if (scan.energy && input.energyPrefs) {
    const ids = new Set<string>();
    collectIds(input.energyPrefs, ids);
    for (const id of ids) { statistics.add(id); if (ENTITY.test(id)) entities.add(id); }
  }

  const deviceById = new Map(input.devices.map((d) => [d.id, d]));
  const areaById = new Map(input.areas.map((a) => [a.area_id, a]));
  const deviceIds = new Set<string>();
  const areaIds = new Set<string>();
  const labelIds = new Set<string>();

  const addLabels = (labels?: string[]) => labels?.forEach((l) => labelIds.add(l));
  for (const e of input.registry) {
    if (!entities.has(e.entity_id)) continue;
    addLabels(e.labels);
    if (e.area_id) areaIds.add(e.area_id);
    if (e.device_id) {
      deviceIds.add(e.device_id);
      const d = deviceById.get(e.device_id);
      if (d?.area_id) areaIds.add(d.area_id);
      addLabels(d?.labels);
    }
  }
  for (const s of scan.strings) {
    if (deviceById.has(s)) deviceIds.add(s);
    if (areaById.has(s)) areaIds.add(s);
    if (input.labelIds.includes(s)) labelIds.add(s);
  }
  const floorIds = new Set<string>();
  for (const a of areaIds) {
    const area = areaById.get(a);
    if (area?.floor_id) floorIds.add(area.floor_id);
    addLabels(area?.labels);
  }
  for (const s of scan.strings) if (input.floorIds.includes(s)) floorIds.add(s);

  return {
    view: input.view, entities, statistics, templates: scan.templates, energy: scan.energy,
    deviceIds, areaIds, floorIds, labelIds,
    domains: new Set([...entities].map((e) => e.split('.')[0])),
  };
}

/** Computes Published for one publication from live Core data, cached briefly. */
export class PublishedProvider {
  #pub: Publication;
  #haUrl: string;
  #viewer: Viewer;
  #cache?: { at: number; value: Published };
  #inflight?: Promise<Published>;

  constructor(pub: Publication, haUrl: string, viewer: Viewer) {
    this.#pub = pub;
    this.#haUrl = haUrl;
    this.#viewer = viewer;
  }

  get(): Promise<Published> {
    if (this.#cache && Date.now() - this.#cache.at < TTL_MS) return Promise.resolve(this.#cache.value);
    this.#inflight ??= this.#compute()
      .then((value) => { this.#cache = { at: Date.now(), value }; return value; })
      .catch((e) => {
        log.warn(`Could not read the published view (${(e as Error).message}); ${this.#cache ? 'using the last good result' : 'publishing nothing'}`);
        return this.#cache?.value ?? EMPTY;
      })
      .finally(() => { this.#inflight = undefined; });
    return this.#inflight;
  }

  async #compute(): Promise<Published> {
    const core = await HaSocket.connect(wsUrl(this.#haUrl), await this.#viewer.accessToken());
    try {
      const urlPath = this.#pub.dashboard === 'lovelace' ? null : this.#pub.dashboard;
      const cfg = await core.request('lovelace/config', { url_path: urlPath, force: false });
      const view = cfg.success ? pickView(cfg.result, this.#pub.view) : null;
      if (!view) log.warn(`View "${this.#pub.view}" not found in dashboard "${this.#pub.dashboard}"; publishing nothing`);
      const scan = view ? scanView(view) : undefined;
      const [registry, devices, areas, floors, labels] = await Promise.all([
        core.call<EntityEntry[]>('config/entity_registry/list'),
        core.call<Device[]>('config/device_registry/list'),
        core.call<Area[]>('config/area_registry/list'),
        core.call<Array<{ floor_id: string }>>('config/floor_registry/list'),
        core.call<Array<{ label_id: string }>>('config/label_registry/list'),
      ]);
      let energyPrefs: unknown;
      if (scan?.energy) {
        const prefs = await core.request('energy/get_prefs');
        if (prefs.success) energyPrefs = prefs.result;
      }
      return computePublished({
        view, registry, devices, areas,
        floorIds: floors.map((f) => f.floor_id), labelIds: labels.map((l) => l.label_id), energyPrefs,
      });
    } finally {
      core.close();
    }
  }
}
