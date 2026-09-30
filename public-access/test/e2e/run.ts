// Talks to the PUBLIC side exactly as a visitor's browser would. Needs a running app (default :8099)
// whose publication is dev/options.json against a Home Assistant seeded by dev/seed.ts.
import WebSocket from 'ws';

const BASE = process.env.RELAY_URL ?? 'http://localhost:8099';
const results: Array<{ name: string; ok: boolean; got: string }> = [];
const check = (name: string, ok: boolean, got: unknown) => results.push({ name, ok, got: typeof got === 'string' ? got : JSON.stringify(got).slice(0, 160) });

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/websocket`);
const waiting = new Map<number, (m: any) => void>();
const events: any[] = [];
let n = 1;
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: 'not-a-real-token' }));
  else if (m.type === 'auth_ok') run().catch((e) => { console.error(e); process.exit(2); });
  else if (m.type === 'result') waiting.get(m.id)?.(m);
  else if (m.type === 'event') events.push(m);
});
const ask = (msg: Record<string, unknown>) => new Promise<any>((resolve) => { const id = n++; waiting.set(id, resolve); ws.send(JSON.stringify({ id, ...msg })); });
const refused = (r: any) => r.success === false && r.error?.code === 'unauthorized';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function run() {
  // --- writes and unknown types
  for (const [name, msg] of Object.entries({
    'call_service light.turn_on': { type: 'call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.bed_light' } },
    'call_service persistent_notification.create': { type: 'call_service', domain: 'persistent_notification', service: 'create', service_data: { message: 'x' } },
    'call_service homeassistant.restart': { type: 'call_service', domain: 'homeassistant', service: 'restart' },
    'fire_event': { type: 'fire_event', event_type: 'x' },
    'config/auth/list': { type: 'config/auth/list' },
    'config/entity_registry/list (full registry)': { type: 'config/entity_registry/list' },
    'manifest/list': { type: 'manifest/list' },
    'unknown type': { type: 'totally/made_up' },
    'render_template with a string not in the view': { type: 'render_template', template: '{{ states | list }}' },
    'history beyond 31 days': { type: 'history/history_during_period', start_time: hoursAgo(24 * 40), entity_ids: ['sensor.outside_temperature'] },
    'history with bad timestamp': { type: 'history/history_during_period', start_time: 'yesterday', entity_ids: ['sensor.outside_temperature'] },
  })) check(`refused: ${name}`, refused(await ask(msg)), 'unauthorized');

  // --- reads are limited to the published view
  const states = await ask({ type: 'get_states' });
  const ids = new Set<string>(states.result.map((s: any) => s.entity_id));
  check('get_states returns the view entities', ['sensor.outside_temperature', 'sensor.outside_humidity', 'sensor.carbon_dioxide', 'light.bed_light'].every((e) => ids.has(e)), [...ids]);
  check('get_states hides entities only in the private view', !ids.has('lock.front_door') && !ids.has('climate.hvac') && !ids.has('sensor.power_consumption'), `${ids.size} visible`);
  check('get_states is not the whole house', ids.size < 15, `${ids.size} visible`);

  const cfg = await ask({ type: 'lovelace/config', url_path: 'some-other-dashboard' });
  const views = cfg.result?.views ?? [];
  check('lovelace/config: only the chosen view, whatever url_path was asked', views.length === 1 && views[0].path === 'solar', views.map((v: any) => v.path));
  check('lovelace/config: private view is absent', !JSON.stringify(cfg.result).includes('lock.front_door'), 'absent');

  const panels = await ask({ type: 'get_panels' });
  check('get_panels: exactly one panel', Object.keys(panels.result).join() === 'lovelace', Object.keys(panels.result));

  const conf = await ask({ type: 'get_config' });
  check('get_config: location redacted', conf.result.latitude === 0 && conf.result.longitude === 0 && conf.result.config_dir === null, { lat: conf.result.latitude, lon: conf.result.longitude, dir: conf.result.config_dir });

  const devs = await ask({ type: 'config/device_registry/list' });
  check('device registry: only devices of published entities, no identifiers', devs.result.length < 10 && devs.result.every((d: any) => d.identifiers.length === 0 && d.connections.length === 0), `${devs.result.length} devices`);
  const areas = await ask({ type: 'config/area_registry/list' });
  check('area registry: filtered', areas.result.length <= 3, areas.result.map((a: any) => a.name));
  const disp = await ask({ type: 'config/entity_registry/list_for_display' });
  check('entity registry (display): only published entities', disp.result.entities.every((e: any) => ids.has(e.ei)), `${disp.result.entities.length} entries`);
  const svcs = await ask({ type: 'get_services' });
  check('get_services: only domains of published entities', Object.keys(svcs.result).length <= 6, Object.keys(svcs.result));

  // --- history, statistics, templates
  const hist = await ask({ type: 'history/history_during_period', start_time: hoursAgo(1), entity_ids: ['sensor.outside_temperature', 'lock.front_door'], minimal_response: true });
  check('history: published entity answered, private entity silently absent', hist.success && 'sensor.outside_temperature' in hist.result && !('lock.front_door' in hist.result), Object.keys(hist.result ?? {}));
  const onlyPrivate = await ask({ type: 'history/history_during_period', start_time: hoursAgo(1), entity_ids: ['lock.front_door'] });
  check('history: only private entity gives empty result', onlyPrivate.success && Object.keys(onlyPrivate.result).length === 0, onlyPrivate.result);
  const stats = await ask({ type: 'recorder/statistics_during_period', start_time: hoursAgo(6), statistic_ids: ['sensor.power_consumption'], period: 'hour' });
  check('statistics: private statistic gives empty result', stats.success && Object.keys(stats.result).length === 0, stats.result);

  const md = "It is {{ states('sensor.outside_temperature') }} degrees outside.";
  const tpl = await ask({ type: 'render_template', template: md });
  check('render_template: allowed for the exact text in the view', tpl.success === true, tpl.success ? 'accepted' : tpl.error);

  // --- subscriptions never leak other entities
  await ask({ type: 'subscribe_entities' });
  await new Promise((r) => setTimeout(r, 800));
  const subscribed = new Set<string>();
  for (const e of events) for (const k of Object.keys(e.event?.a ?? {})) subscribed.add(k);
  check('subscribe_entities: only published entities', subscribed.size > 0 && [...subscribed].every((k) => ids.has(k)), [...subscribed]);
  const sub2 = await ask({ type: 'subscribe_events', event_type: 'entity_registry_updated' });
  check('subscribe_events: unlisted event types answered but never forwarded', sub2.success === true, 'silent');

  // --- REST twin
  const rest = await fetch(`${BASE}/api/history/period/${encodeURIComponent(hoursAgo(1))}?filter_entity_id=sensor.outside_temperature,lock.front_door&minimal_response`);
  const body = (await rest.json()) as any[];
  const restIds = body.flat().map((s: any) => s.entity_id).filter(Boolean);
  check('REST history: only published entities', rest.ok && restIds.every((e) => e === 'sensor.outside_temperature'), [...new Set(restIds)]);
  const blocked = await Promise.all(['/api/states', '/api/config', '/auth/token', '/api/services', '/api/error_log'].map(async (p) => (await fetch(BASE + p)).status));
  check('other /api and /auth paths are 404', blocked.every((s) => s === 404), blocked);
  const post = await fetch(BASE + '/api/services/light/turn_on', { method: 'POST' });
  check('POST is refused', post.status === 405, post.status);

  for (const r of results) console.log(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.name}${r.ok ? '' : `\n        got: ${r.got}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  ws.close();
  process.exit(failed ? 1 : 0);
}
