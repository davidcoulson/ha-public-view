/**
 * The rules. Everything a visitor may ask (inbound) and everything they may be told (outbound)
 * is decided here, as pure functions over plain objects, so each rule has a unit test.
 *
 * Inbound is an allowlist that REBUILDS the message from named fields: a field the rule does not
 * name never reaches Core, whatever the visitor sent.
 */
import { pickView } from './scan.ts';
import type { Published } from './published.ts';

export interface Ctx {
  /** Key of the real dashboard in Core's panel list ("lovelace" for the default dashboard). */
  dashboardKey: string;
  /** url_path to ask Core for; null for the default dashboard. */
  dashboardUrlPath: string | null;
  viewPath: string;
  title?: string;
}

export type Msg = Record<string, any>;
export type Inbound =
  | { kind: 'forward'; msg: Msg }
  | { kind: 'reply'; result: unknown; silentSubscription?: boolean }
  | { kind: 'refuse'; reason: string };

/** The one panel a visitor sees. "lovelace" is Core's default panel key, so "/" lands here with no redirect tricks. */
export const PUBLIC_PANEL = 'lovelace';

const DAY = 86_400_000;
const MAX_HISTORY_SPAN = 31 * DAY;
const MAX_STATISTICS_SPAN = 800 * DAY;
const STAT_PERIODS = new Set(['5minute', 'hour', 'day', 'week', 'month']);
const EVENT_TYPES = new Set(['state_changed', 'core_config_updated', 'themes_updated', 'panels_updated', 'lovelace_updated']);

const refuse = (reason: string): Inbound => ({ kind: 'refuse', reason });
const reply = (result: unknown): Inbound => ({ kind: 'reply', result });
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Copies only the named keys, and only when present. */
function pick(msg: Msg, keys: string[]): Msg {
  const out: Msg = {};
  for (const k of keys) if (msg[k] !== undefined) out[k] = msg[k];
  return out;
}

function pickBools(msg: Msg, keys: string[]): Msg | null {
  const out: Msg = {};
  for (const k of keys) {
    if (msg[k] === undefined) continue;
    if (!isBool(msg[k])) return null;
    out[k] = msg[k];
  }
  return out;
}

function allowedIds(ids: unknown, allowed: Set<string>): string[] {
  return Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => isStr(x) && allowed.has(x)))].sort() : [];
}

/** Valid ISO timestamps whose span does not exceed `max`. Returns null when not acceptable. */
function window(msg: Msg, max: number, now = Date.now()): Msg | null {
  if (!isStr(msg.start_time)) return null;
  const start = Date.parse(msg.start_time);
  if (Number.isNaN(start)) return null;
  const out: Msg = { start_time: msg.start_time };
  let end = now;
  if (msg.end_time !== undefined && msg.end_time !== null) {
    if (!isStr(msg.end_time)) return null;
    end = Date.parse(msg.end_time);
    if (Number.isNaN(end)) return null;
    out.end_time = msg.end_time;
  }
  if (end < start || end - start > max) return null;
  return out;
}

const plain = (msg: Msg, keys: string[] = []): Inbound => ({ kind: 'forward', msg: pick(msg, ['id', 'type', ...keys]) });

// Answered here with an empty success. The frontend gets an answer; the owner's repairs,
// notifications and preferences never move, and nothing is written.
const QUIET: Record<string, unknown> = {
  'repairs/list_issues': { issues: [] },
  'persistent_notification/subscribe': null,
  'labs/subscribe': null,
  'usage_prediction/common_control': { entities: [] },
  'config_entries/flow/subscribe': null,
  'frontend/set_user_data': null,
  'frontend/set_system_data': null,
};

type Rule = (msg: Msg, pub: Published, ctx: Ctx) => Inbound;

const RULES: Record<string, Rule> = {
  ping: (m) => plain(m),
  supported_features: (m) => plain(m, ['features']),
  'auth/current_user': (m) => plain(m),
  get_config: (m) => plain(m),
  get_services: (m) => plain(m),
  get_panels: (m) => plain(m),
  get_states: (m) => plain(m),
  'recorder/info': (m) => plain(m),
  'sensor/numeric_device_classes': (m) => plain(m),
  'lovelace/info': (m) => plain(m),
  'lovelace/resources': (m) => plain(m),
  'frontend/get_themes': (m) => plain(m),
  'config/area_registry/list': (m) => plain(m),
  'config/floor_registry/list': (m) => plain(m),
  'config/label_registry/list': (m) => plain(m),
  'config/device_registry/list': (m) => plain(m),
  'config/entity_registry/list_for_display': (m) => plain(m),

  'frontend/get_translations': (m) => (isStr(m.language) && isStr(m.category) ? plain(m, ['language', 'category', 'integration']) : refuse('bad arguments')),
  'frontend/get_icons': (m) => (isStr(m.category) ? plain(m, ['category', 'integration']) : refuse('bad arguments')),
  'frontend/get_user_data': (m) => plain(m, ['key']),
  'frontend/subscribe_user_data': (m) => plain(m, ['key']),
  'frontend/get_system_data': (m) => plain(m, ['key']),
  'frontend/subscribe_system_data': (m) => plain(m, ['key']),

  'lovelace/config': (m, _p, ctx) => ({ kind: 'forward', msg: { id: m.id, type: m.type, url_path: ctx.dashboardUrlPath, force: false } }),

  subscribe_entities: (m, pub) => {
    const ids = [...pub.entities].sort();
    // An empty entity_ids list means "everything" to Core, so an empty allowlist must never be forwarded.
    return ids.length ? { kind: 'forward', msg: { id: m.id, type: m.type, entity_ids: ids } } : reply(null);
  },
  subscribe_events: (m) => {
    const type = m.event_type ?? '*';
    if (isStr(type) && EVENT_TYPES.has(type)) return { kind: 'forward', msg: { id: m.id, type: m.type, event_type: type } };
    return { kind: 'reply', result: null, silentSubscription: true };
  },
  unsubscribe_events: (m) => (typeof m.subscription === 'number' ? plain(m, ['subscription']) : refuse('bad arguments')),

  'history/history_during_period': (m, pub) => history(m, pub),
  'history/stream': (m, pub) => history(m, pub),

  'recorder/list_statistic_ids': (m) => plain(m, ['statistic_type']),
  'recorder/get_statistics_metadata': (m, pub) => {
    const ids = allowedIds(m.statistic_ids, pub.statistics);
    return ids.length ? { kind: 'forward', msg: { id: m.id, type: m.type, statistic_ids: ids } } : reply([]);
  },
  'recorder/statistics_during_period': (m, pub) => {
    const w = window(m, MAX_STATISTICS_SPAN);
    if (!w || !isStr(m.period) || !STAT_PERIODS.has(m.period)) return refuse('bad arguments');
    const ids = allowedIds(m.statistic_ids, pub.statistics);
    if (!ids.length) return reply({});
    return { kind: 'forward', msg: { id: m.id, type: m.type, ...w, statistic_ids: ids, period: m.period, ...pick(m, ['types', 'units']) } };
  },
  'recorder/statistic_during_period': (m, pub) => {
    if (!isStr(m.statistic_id) || !pub.statistics.has(m.statistic_id)) return reply(null);
    return plain(m, ['statistic_id', 'types', 'units', 'fixed_period', 'calendar', 'rolling_window']);
  },
  'weather/subscribe_forecast': (m, pub) => {
    if (!isStr(m.entity_id) || !isStr(m.forecast_type)) return refuse('bad arguments');
    return pub.entities.has(m.entity_id) ? plain(m, ['entity_id', 'forecast_type']) : reply(null);
  },

  render_template: (m, pub) => {
    // Only text the owner put in the view. Anything else could read every state.
    if (!isStr(m.template) || !pub.templates.has(m.template)) return refuse('template not in the published view');
    const out: Msg = { id: m.id, type: m.type, template: m.template, ...pick(m, ['timeout', 'report_errors']) };
    if (m.variables && typeof m.variables === 'object') {
      const vars = pick(m.variables as Msg, ['config', 'user']);
      if (JSON.stringify(vars).length <= 8000) out.variables = vars;
    }
    return { kind: 'forward', msg: out };
  },

  'energy/get_prefs': (m, pub) => (pub.energy ? plain(m) : reply({ energy_sources: [], device_consumption: [] })),
  'energy/info': (m, pub) => (pub.energy ? plain(m) : reply({ cost_sensors: {}, solar_forecast_domains: [] })),
};

function history(m: Msg, pub: Published): Inbound {
  const w = window(m, MAX_HISTORY_SPAN);
  const flags = pickBools(m, ['include_start_time_state', 'significant_changes_only', 'minimal_response', 'no_attributes']);
  if (!w || !flags) return refuse('bad arguments');
  const ids = allowedIds(m.entity_ids, pub.entities);
  if (!ids.length) return reply({});
  return { kind: 'forward', msg: { id: m.id, type: m.type, ...w, entity_ids: ids, ...flags } };
}

export function inbound(msg: unknown, pub: Published, ctx: Ctx): Inbound {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return refuse('not an object');
  const m = msg as Msg;
  if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 1 || !isStr(m.type)) return refuse('bad envelope');
  // The frontend reports its own errors this way; answer, never forward.
  if (m.type === 'call_service' && m.domain === 'system_log') return reply(null);
  if (Object.hasOwn(QUIET, m.type)) return reply(QUIET[m.type]);
  const rule = Object.hasOwn(RULES, m.type) ? RULES[m.type] : undefined;
  if (!rule) return refuse(`type not allowed: ${m.type}`);
  return rule(m, pub, ctx);
}

/** Label for counting refusals without letting a visitor create unbounded keys. */
export function refusalKey(msg: unknown): string {
  const m = msg as Msg | null;
  const t = m && typeof m.type === 'string' ? m.type.slice(0, 60) : 'invalid';
  return t === 'call_service' ? `call_service:${String(m?.domain).slice(0, 40)}.${String(m?.service).slice(0, 40)}` : t;
}

// ---------------------------------------------------------------- outbound

const REDACTED_CONFIG = ['latitude', 'longitude', 'elevation', 'config_dir', 'external_url', 'internal_url', 'allowlist_external_dirs', 'allowlist_external_urls', 'whitelist_external_dirs'];
const DEVICE_KEYS = ['id', 'name', 'name_by_user', 'area_id', 'manufacturer', 'model', 'model_id', 'entry_type', 'disabled_by', 'labels', 'created_at', 'modified_at'];

function sanitizeDevice(d: Msg): Msg {
  const out: Msg = {};
  for (const k of DEVICE_KEYS) if (d[k] !== undefined) out[k] = d[k];
  // Identifiers and connections contain MAC addresses and serial numbers. Keep the shape, drop the content.
  Object.assign(out, { config_entries: [], connections: [], identifiers: [], via_device_id: null, sw_version: null, hw_version: null, serial_number: null, configuration_url: null, primary_config_entry: null });
  return out;
}

function panels(result: Msg, ctx: Ctx): Msg {
  const source = (result[ctx.dashboardKey] ?? {}) as Msg;
  return {
    [PUBLIC_PANEL]: {
      component_name: 'lovelace',
      icon: source.icon ?? null,
      title: ctx.title ?? source.title ?? 'Dashboard',
      config: { mode: 'storage' },
      url_path: PUBLIC_PANEL,
      require_admin: false,
      config_panel_domain: null,
    },
  };
}

function pinDefaultPanel(value: unknown): void {
  if (Array.isArray(value)) value.forEach(pinDefaultPanel);
  else if (value && typeof value === 'object') {
    const o = value as Msg;
    for (const k of Object.keys(o)) { if (k === 'default_panel') o[k] = PUBLIC_PANEL; else pinDefaultPanel(o[k]); }
  }
}

const filterKeys = (o: unknown, ok: (k: string) => boolean): Msg =>
  Object.fromEntries(Object.entries((o ?? {}) as Msg).filter(([k]) => ok(k)));

/**
 * `type` is what the visitor asked (recorded by the session); `m` is Core's answer or event.
 * Returns the message to send on, or null to drop it. Throwing also drops it.
 */
export function outbound(type: string, m: Msg, pub: Published, ctx: Ctx): Msg | null {
  const isResult = m.type === 'result';
  const ok = isResult && m.success === true;

  switch (type) {
    case 'get_states':
      if (!ok) return m;
      if (!Array.isArray(m.result)) return null;
      m.result = m.result.filter((s: Msg) => pub.entities.has(s.entity_id));
      return m;

    case 'subscribe_entities': {
      if (m.type !== 'event') return m;
      const e = m.event ?? {};
      for (const bucket of ['a', 'c']) if (e[bucket]) e[bucket] = filterKeys(e[bucket], (k) => pub.entities.has(k));
      if (Array.isArray(e.r)) e.r = e.r.filter((k: string) => pub.entities.has(k));
      return m;
    }

    case 'subscribe_events': {
      if (m.type !== 'event') return m;
      const data = m.event?.data;
      if (m.event?.event_type === 'state_changed') return data && pub.entities.has(data.entity_id) ? m : null;
      return m;
    }

    case 'get_config':
      if (!ok) return m;
      for (const k of REDACTED_CONFIG) {
        if (!(k in m.result)) continue;
        m.result[k] = Array.isArray(m.result[k]) ? [] : typeof m.result[k] === 'number' ? 0 : null;
      }
      return m;

    case 'get_services':
      if (!ok) return m;
      m.result = filterKeys(m.result, (d) => pub.domains.has(d) || d === 'homeassistant');
      return m;

    case 'get_panels':
      if (!ok) return m;
      m.result = panels(m.result, ctx);
      return m;

    case 'lovelace/config': {
      if (!ok) return m;
      const view = pickView(m.result, ctx.viewPath);
      const cfg = m.result as Msg;
      m.result = { ...(cfg.title !== undefined ? { title: cfg.title } : {}), ...(cfg.background !== undefined ? { background: cfg.background } : {}), views: view ? [view] : [] };
      return m;
    }

    case 'auth/current_user':
      if (!ok) return m;
      Object.assign(m.result, { id: 'public-viewer', name: 'Visitor', is_admin: false, is_owner: false, credentials: [], mfa_modules: [] });
      return m;

    case 'frontend/get_user_data':
    case 'frontend/subscribe_user_data':
    case 'frontend/get_system_data':
    case 'frontend/subscribe_system_data':
      pinDefaultPanel(m.result);
      pinDefaultPanel(m.event);
      return m;

    case 'config/entity_registry/list_for_display':
      if (!ok) return m;
      m.result.entities = (m.result.entities ?? []).filter((e: Msg) => pub.entities.has(e.ei));
      return m;

    case 'config/device_registry/list':
      if (!ok) return m;
      m.result = (m.result as Msg[]).filter((d) => pub.deviceIds.has(d.id)).map(sanitizeDevice);
      return m;

    case 'config/area_registry/list':
      if (!ok) return m;
      m.result = (m.result as Msg[]).filter((a) => pub.areaIds.has(a.area_id)).map((a) => ({ ...a, aliases: [] }));
      return m;

    case 'config/floor_registry/list':
      if (!ok) return m;
      m.result = (m.result as Msg[]).filter((f) => pub.floorIds.has(f.floor_id)).map((f) => ({ ...f, aliases: [] }));
      return m;

    case 'config/label_registry/list':
      if (!ok) return m;
      m.result = (m.result as Msg[]).filter((l) => pub.labelIds.has(l.label_id));
      return m;

    case 'recorder/list_statistic_ids':
    case 'recorder/get_statistics_metadata':
      if (!ok) return m;
      m.result = (m.result as Msg[]).filter((s) => pub.statistics.has(s.statistic_id));
      return m;

    default:
      return m;
  }
}
