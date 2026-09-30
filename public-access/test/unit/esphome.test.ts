import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDevice } from 'esphome-device/testing';
import { buildEntities, slug, type Controls } from '../../src/esphome/entities.ts';
import { PublicationStore } from '../../src/publications.ts';
import { Settings } from '../../src/settings.ts';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pa-es-'));
  const store = await PublicationStore.load(dir, [
    { hostname: 'solar.example.com', dashboard: 'energy', view: 'solar', noindex: true, enabled: true },
    { hostname: 'weather.example.com', dashboard: 'w', view: 'now', noindex: true, enabled: true },
  ]);
  const settings = await Settings.load(dir, { paused: false, maxSessions: 50, maxSessionsPerVisitor: 6, logLevel: 'info' });
  const calls = { disconnected: [] as string[], refreshed: 0, logLevel: '' };
  const stats = { active: 3, sessions: 10, refusedTotal: 4, rateLimited: 1 };
  let health = { core: true, message: 'ok' };
  const controls: Controls = {
    settings, store, stats,
    visitorsByHost: () => new Map([['solar.example.com', 2], ['weather.example.com', 1]]),
    disconnectAll: (r) => { calls.disconnected.push(r); return 3; },
    health: () => health,
    publishedEntities: () => 7,
    refreshViews: () => { calls.refreshed++; },
    setLogLevel: (l) => { calls.logLevel = l; },
  };
  const dev = new FakeDevice({ name: 'public-access' });
  const { update } = buildEntities(dev as never, controls);
  const last = (id: string) => dev.entities.get(id)?.state;
  return { dev, settings, store, stats, calls, update, last, setHealth: (h: typeof health) => { health = h; } };
}

test('declares the expected monitoring and configuration entities', async () => {
  const { dev } = await setup();
  const ids = dev.declared.map((d) => d.objectId).sort();
  for (const id of ['serve_visitors', 'max_visitors', 'max_per_visitor', 'log_level', 'disconnect_visitors', 'reload_view', 'status', 'core_link', 'visitors', 'visits', 'refused_requests', 'rate_limited', 'published_entities', 'publish_solar_example_com', 'visitors_solar_example_com', 'publish_weather_example_com']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
});

test('sensors report the live numbers', async () => {
  const { last, stats, update } = await setup();
  assert.equal(last('visitors'), 3);
  assert.equal(last('visits'), 10);
  assert.equal(last('refused_requests'), 4);
  assert.equal(last('published_entities'), 7);
  assert.equal(last('visitors_solar_example_com'), 2);
  stats.active = 5; stats.sessions = 12;
  update();
  assert.equal(last('visitors'), 5);
  assert.equal(last('visits'), 12);
});

test('status text follows the state of the add-on', async () => {
  const { last, update, setHealth, settings } = await setup();
  assert.equal(last('status'), 'Serving 2 publications');
  setHealth({ core: false, message: 'Core answered 502' }); update();
  assert.equal(last('status'), 'Waiting for Home Assistant: Core answered 502');
  assert.equal(last('core_link'), false);
  setHealth({ core: true, message: 'ok' });
  await settings.update({ paused: true }); update();
  assert.equal(last('status'), 'Paused');
});

test('the Serve visitors switch pauses, disconnects everyone, and resumes', async () => {
  const { dev, settings, calls, last } = await setup();
  await dev.command('serve_visitors', false);
  assert.equal(settings.data.paused, true);
  assert.deepEqual(calls.disconnected, ['paused by owner']);
  assert.equal(last('serve_visitors'), false);
  await dev.command('serve_visitors', true);
  assert.equal(settings.data.paused, false);
});

test('numbers are clamped and the accepted value is what Home Assistant sees', async () => {
  const { dev, settings, last } = await setup();
  await dev.command('max_visitors', 120.4);
  assert.equal(settings.data.maxSessions, 120);
  assert.equal(last('max_visitors'), 120);
  await dev.command('max_per_visitor', 999);
  assert.equal(settings.data.maxSessionsPerVisitor, 50);
  assert.equal(last('max_per_visitor'), 50);
});

test('log level select changes the running level', async () => {
  const { dev, settings, calls } = await setup();
  await dev.command('log_level', 'debug');
  assert.equal(settings.data.logLevel, 'debug');
  assert.equal(calls.logLevel, 'debug');
});

test('buttons disconnect visitors and reload the view', async () => {
  const { dev, calls } = await setup();
  await dev.press('disconnect_visitors');
  await dev.press('reload_view');
  assert.deepEqual(calls.disconnected, ['disconnected by owner']);
  assert.equal(calls.refreshed, 1);
});

test('a publication switch hides that publication and keeps the other', async () => {
  const { dev, store } = await setup();
  await dev.command('publish_solar_example_com', false);
  assert.deepEqual(store.list().map((p) => [p.hostname, p.enabled]), [['solar.example.com', false], ['weather.example.com', true]]);
});

test('settings are saved and survive a restart; bad values are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-set-'));
  const defaults = { paused: false, maxSessions: 50, maxSessionsPerVisitor: 6, logLevel: 'info' as const };
  const a = await Settings.load(dir, defaults);
  await a.update({ paused: true, maxSessions: 9999, logLevel: 'nope' as never });
  assert.equal(a.data.maxSessions, 500);
  assert.equal(a.data.logLevel, 'info');
  const b = await Settings.load(dir, defaults);
  assert.equal(b.data.paused, true);
  assert.equal(b.data.maxSessions, 500);
});

test('slug makes stable object ids from host names', () => {
  assert.equal(slug('Solar.Example.com'), 'solar_example_com');
  assert.equal(slug('a--b.c'), 'a_b_c');
});
