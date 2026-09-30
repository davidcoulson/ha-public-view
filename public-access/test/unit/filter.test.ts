import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inbound, outbound, refusalKey, type Msg } from '../../src/policy/filter.ts';
import { ctx, EMPTY, published } from './helpers.ts';

const pub = published();
const ask = (m: unknown) => inbound(m, pub, ctx);
const forwarded = (m: unknown) => { const d = ask(m); assert.equal(d.kind, 'forward'); return (d as { msg: Msg }).msg; };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

test('rejects anything that is not a well-formed envelope', () => {
  for (const bad of [null, 'x', [], {}, { type: 'get_states' }, { id: 0, type: 'get_states' }, { id: 1.5, type: 'get_states' }, { id: '1', type: 'get_states' }, { id: 1 }, { id: 1, type: 5 }]) {
    assert.equal(ask(bad).kind, 'refuse', JSON.stringify(bad));
  }
});

test('refuses every write and every type not on the list', () => {
  for (const type of ['call_service', 'fire_event', 'config/auth/list', 'config/entity_registry/list', 'config/entity_registry/get', 'manifest/list', 'subscribe_trigger', 'execute_script', 'lovelace/config/save', 'auth/long_lived_access_token', 'supervisor/api']) {
    assert.equal(ask({ id: 1, type, domain: 'light', service: 'turn_on' }).kind, 'refuse', type);
  }
});

test('type names that are properties of Object are not on the list', () => {
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(ask({ id: 1, type }).kind, 'refuse', type);
  }
});

test('the frontend error report is answered quietly, other system_log calls included', () => {
  assert.deepEqual(ask({ id: 1, type: 'call_service', domain: 'system_log', service: 'write', service_data: { message: 'x' } }), { kind: 'reply', result: null });
});

test('forwarded messages are rebuilt: unknown fields never reach Core', () => {
  const m = forwarded({ id: 7, type: 'get_states', evil: true, target: { entity_id: 'all' } });
  assert.deepEqual(m, { id: 7, type: 'get_states' });
  const t = forwarded({ id: 8, type: 'frontend/get_translations', language: 'en', category: 'state', extra: 1 });
  assert.deepEqual(t, { id: 8, type: 'frontend/get_translations', language: 'en', category: 'state' });
});

test('lovelace/config always asks for the configured dashboard', () => {
  assert.deepEqual(forwarded({ id: 2, type: 'lovelace/config', url_path: 'admin-only', force: true }), { id: 2, type: 'lovelace/config', url_path: 'public-test', force: false });
});

test('subscribe_entities lists only published entities, and never goes out with an empty list', () => {
  assert.deepEqual(forwarded({ id: 3, type: 'subscribe_entities', entity_ids: ['lock.secret'] }).entity_ids, ['light.lamp', 'sensor.js_ref', 'sensor.other', 'sensor.temp']);
  // An empty entity_ids list means "everything" to Core.
  assert.deepEqual(inbound({ id: 3, type: 'subscribe_entities' }, EMPTY, ctx), { kind: 'reply', result: null });
});

test('history: filters entities, caps the window, validates flags', () => {
  const m = forwarded({ id: 4, type: 'history/history_during_period', start_time: hoursAgo(2), entity_ids: ['sensor.temp', 'lock.secret'], minimal_response: true, junk: 1 });
  assert.deepEqual(m.entity_ids, ['sensor.temp']);
  assert.equal(m.junk, undefined);
  assert.deepEqual(ask({ id: 4, type: 'history/stream', start_time: hoursAgo(2), entity_ids: ['lock.secret'] }), { kind: 'reply', result: {} });
  assert.equal(ask({ id: 4, type: 'history/stream', start_time: hoursAgo(24 * 40), entity_ids: ['sensor.temp'] }).kind, 'refuse');
  assert.equal(ask({ id: 4, type: 'history/stream', start_time: 'soon', entity_ids: ['sensor.temp'] }).kind, 'refuse');
  assert.equal(ask({ id: 4, type: 'history/stream', start_time: hoursAgo(2), end_time: hoursAgo(3), entity_ids: ['sensor.temp'] }).kind, 'refuse');
  assert.equal(ask({ id: 4, type: 'history/stream', start_time: hoursAgo(2), entity_ids: ['sensor.temp'], minimal_response: 'yes' }).kind, 'refuse');
});

test('statistics: only published ids, known periods, bounded window', () => {
  const ok = forwarded({ id: 5, type: 'recorder/statistics_during_period', start_time: hoursAgo(24), statistic_ids: ['sensor.temp', 'sensor.power'], period: 'hour', types: ['mean'] });
  assert.deepEqual(ok.statistic_ids, ['sensor.temp']);
  assert.deepEqual(ask({ id: 5, type: 'recorder/statistics_during_period', start_time: hoursAgo(24), statistic_ids: ['sensor.power'], period: 'hour' }), { kind: 'reply', result: {} });
  assert.equal(ask({ id: 5, type: 'recorder/statistics_during_period', start_time: hoursAgo(24), statistic_ids: ['sensor.temp'], period: 'decade' }).kind, 'refuse');
  assert.equal(ask({ id: 5, type: 'recorder/statistics_during_period', start_time: hoursAgo(24 * 900), statistic_ids: ['sensor.temp'], period: 'day' }).kind, 'refuse');
  assert.deepEqual(ask({ id: 6, type: 'recorder/statistic_during_period', statistic_id: 'sensor.power' }), { kind: 'reply', result: null });
});

test('render_template only for text that is verbatim in the view', () => {
  const tpl = "It is {{ states('sensor.temp') }} out";
  const m = forwarded({ id: 9, type: 'render_template', template: tpl, variables: { config: { a: 1 }, user: 'x', states: 'nope' }, entity_ids: ['all'] });
  assert.equal(m.template, tpl);
  assert.deepEqual(Object.keys(m.variables).sort(), ['config', 'user']);
  assert.equal(m.entity_ids, undefined);
  assert.equal(ask({ id: 9, type: 'render_template', template: '{{ states | list }}' }).kind, 'refuse');
  assert.equal(ask({ id: 9, type: 'render_template', template: tpl + ' ' }).kind, 'refuse');
});

test('subscribe_events: listed types go through, others are answered but never forwarded', () => {
  assert.equal(ask({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }).kind, 'forward');
  assert.deepEqual(ask({ id: 1, type: 'subscribe_events', event_type: 'call_service' }), { kind: 'reply', result: null, silentSubscription: true });
  assert.deepEqual(ask({ id: 1, type: 'subscribe_events' }), { kind: 'reply', result: null, silentSubscription: true });
});

test('energy preferences are answered empty unless the view has energy cards', () => {
  assert.deepEqual(ask({ id: 1, type: 'energy/get_prefs' }), { kind: 'reply', result: { energy_sources: [], device_consumption: [] } });
  assert.equal(inbound({ id: 1, type: 'energy/get_prefs' }, published({ energy: true }), ctx).kind, 'forward');
});

test('refusal keys stay bounded whatever the visitor sends', () => {
  assert.equal(refusalKey({ type: 'x'.repeat(500) }).length, 60);
  assert.equal(refusalKey(null), 'invalid');
  assert.equal(refusalKey({ type: 'call_service', domain: 'light', service: 'turn_on' }), 'call_service:light.turn_on');
});

// ------------------------------------------------------------ outbound

test('get_states keeps only published entities', () => {
  const out = outbound('get_states', { id: 1, type: 'result', success: true, result: [{ entity_id: 'sensor.temp' }, { entity_id: 'lock.secret' }] }, pub, ctx)!;
  assert.deepEqual(out.result, [{ entity_id: 'sensor.temp' }]);
  assert.equal(outbound('get_states', { id: 1, type: 'result', success: true, result: 'odd' }, pub, ctx), null);
});

test('subscribe_entities events are filtered in every bucket', () => {
  const out = outbound('subscribe_entities', { id: 1, type: 'event', event: { a: { 'sensor.temp': {}, 'lock.secret': {} }, c: { 'lock.secret': {} }, r: ['lock.secret', 'sensor.temp'] } }, pub, ctx)!;
  assert.deepEqual(out.event, { a: { 'sensor.temp': {} }, c: {}, r: ['sensor.temp'] });
});

test('state_changed events for other entities are dropped', () => {
  const ev = (entity_id: string) => ({ id: 1, type: 'event', event: { event_type: 'state_changed', data: { entity_id } } });
  assert.ok(outbound('subscribe_events', ev('sensor.temp'), pub, ctx));
  assert.equal(outbound('subscribe_events', ev('lock.secret'), pub, ctx), null);
});

test('get_config hides the home location and paths', () => {
  const out = outbound('get_config', { id: 1, type: 'result', success: true, result: { latitude: 51.5, longitude: -0.1, elevation: 30, config_dir: '/config', external_url: 'https://x', allowlist_external_dirs: ['/a'], time_zone: 'UTC', unit_system: {} } }, pub, ctx)!;
  assert.deepEqual({ ...out.result }, { latitude: 0, longitude: 0, elevation: 0, config_dir: null, external_url: null, allowlist_external_dirs: [], time_zone: 'UTC', unit_system: {} });
});

test('get_panels becomes a single panel', () => {
  const out = outbound('get_panels', { id: 1, type: 'result', success: true, result: { 'public-test': { icon: 'mdi:eye', title: 'T' }, config: {}, developer: {} } }, pub, ctx)!;
  assert.deepEqual(Object.keys(out.result), ['lovelace']);
  assert.equal(out.result.lovelace.title, 'Solar');
  assert.equal(out.result.lovelace.require_admin, false);
});

test('lovelace/config: one view, top-level extras dropped, missing view publishes nothing', () => {
  const cfg = { title: 'Home', strategy: { type: 'x' }, resources: [1], views: [{ path: 'private', cards: [] }, { path: 'solar', cards: [1] }] };
  const out = outbound('lovelace/config', { id: 1, type: 'result', success: true, result: cfg }, pub, ctx)!;
  assert.deepEqual(out.result, { title: 'Home', views: [{ path: 'solar', cards: [1] }] });
  const gone = outbound('lovelace/config', { id: 1, type: 'result', success: true, result: { views: [{ path: 'private' }] } }, pub, ctx)!;
  assert.deepEqual(gone.result.views, []);
});

test('device registry: only published devices, with identifying fields removed', () => {
  const dev = (id: string) => ({ id, name: id, area_id: null, identifiers: [['x', 'SERIAL']], connections: [['mac', 'aa:bb']], serial_number: 'S1', sw_version: '1', config_entries: ['c'] });
  const out = outbound('config/device_registry/list', { id: 1, type: 'result', success: true, result: [dev('dev1'), dev('dev2'), dev('dev3')] }, pub, ctx)!;
  assert.deepEqual(out.result.map((d: Msg) => d.id), ['dev1', 'dev2']);
  assert.ok(out.result.every((d: Msg) => d.identifiers.length === 0 && d.connections.length === 0 && d.serial_number === null && d.config_entries.length === 0));
});

test('area and floor registries list only areas of published entities', () => {
  const areas = outbound('config/area_registry/list', { id: 1, type: 'result', success: true, result: [{ area_id: 'garden', aliases: ['a'] }, { area_id: 'kitchen' }, { area_id: 'hall' }] }, pub, ctx)!;
  assert.deepEqual(areas.result.map((a: Msg) => a.area_id), ['garden', 'kitchen']);
  assert.deepEqual(areas.result[0].aliases, []);
  const floors = outbound('config/floor_registry/list', { id: 1, type: 'result', success: true, result: [{ floor_id: 'f1' }, { floor_id: 'f2' }] }, pub, ctx)!;
  assert.deepEqual(floors.result.map((f: Msg) => f.floor_id), ['f1']);
});

test('get_services keeps domains of published entities', () => {
  const out = outbound('get_services', { id: 1, type: 'result', success: true, result: { light: {}, sensor: {}, lock: {}, homeassistant: {}, shell_command: {} } }, pub, ctx)!;
  assert.deepEqual(Object.keys(out.result).sort(), ['homeassistant', 'light', 'sensor']);
});

test('default_panel preferences are pinned to the public panel', () => {
  const out = outbound('frontend/subscribe_system_data', { id: 1, type: 'event', event: { value: { default_panel: 'config' } } }, pub, ctx)!;
  assert.equal(out.event.value.default_panel, 'lovelace');
});

test('errors from Core pass through untouched', () => {
  const err = { id: 1, type: 'result', success: false, error: { code: 'x', message: 'y' } };
  assert.deepEqual(outbound('get_states', { ...err }, pub, ctx), err);
});
