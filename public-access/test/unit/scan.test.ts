import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickView, scanView } from '../../src/policy/scan.ts';
import { computePublished } from '../../src/policy/published.ts';
import { publicationFor } from '../../src/http/server.ts';
import { VIEW } from './helpers.ts';

test('finds entity ids in plain values, templates and JS snippets', () => {
  const s = scanView(VIEW);
  assert.deepEqual([...s.entities].sort(), ['light.lamp', 'sensor.js_ref', 'sensor.other', 'sensor.temp']);
});

test('does not treat file names, versions or urls as entities with a trailing dot segment', () => {
  const s = scanView({ a: 'see image.png', b: 'v1.2.3', c: 'https://example.com/a.b', d: 'light.kitchen' });
  assert.ok(s.entities.has('light.kitchen'));
  assert.ok(!s.entities.has('v1.2'));
});

test('templates are collected verbatim; plain text is not a template', () => {
  const s = scanView({ x: 'hello', y: '{{ 1 }}', z: '{% if a %}b{% endif %}' });
  assert.deepEqual([...s.templates].sort(), ['{% if a %}b{% endif %}', '{{ 1 }}']);
});

test('external statistics and energy cards are detected', () => {
  const s = scanView({ cards: [{ type: 'energy-distribution' }, { statistic: 'sensor:energy_total' }] });
  assert.equal(s.energy, true);
  assert.ok(s.statistics.has('sensor:energy_total'));
  assert.equal(scanView({ type: 'entities' }).energy, false);
});

test('pickView matches numeric paths as text and never falls back to another view', () => {
  const cfg = { views: [{ path: 123456 }, { path: 'other' }, { title: 'no path' }] };
  assert.deepEqual(pickView(cfg, '123456'), { path: 123456 });
  assert.equal(pickView(cfg, 'missing'), null);
  assert.equal(pickView({ views: [{ title: 'first, but no path' }] }, 'x'), null);
  assert.equal(pickView(null, 'x'), null);
});

test('computePublished: devices, areas, floors follow published entities only', () => {
  const p = computePublished({
    view: { cards: [{ entity: 'sensor.a' }, { area: 'lounge' }] },
    registry: [{ entity_id: 'sensor.a', device_id: 'd1' }, { entity_id: 'sensor.b', device_id: 'd2', area_id: 'secret_room' }],
    devices: [{ id: 'd1', area_id: 'porch' }, { id: 'd2', area_id: 'secret_room' }],
    areas: [{ area_id: 'porch', floor_id: 'f0' }, { area_id: 'lounge' }, { area_id: 'secret_room', floor_id: 'f9' }],
    floorIds: ['f0', 'f9'], labelIds: [],
  });
  assert.deepEqual([...p.deviceIds], ['d1']);
  assert.deepEqual([...p.areaIds].sort(), ['lounge', 'porch']);
  assert.deepEqual([...p.floorIds], ['f0']);
});

test('computePublished with no view publishes nothing', () => {
  const p = computePublished({ view: null, registry: [], devices: [], areas: [], floorIds: [], labelIds: [] });
  assert.equal(p.entities.size, 0);
});

test('energy preferences add their statistics when the view has energy cards', () => {
  const p = computePublished({
    view: { cards: [{ type: 'energy-distribution' }] }, registry: [], devices: [], areas: [], floorIds: [], labelIds: [],
    energyPrefs: { energy_sources: [{ stat_energy_from: 'sensor.grid_in', flow_from: [{ stat_energy_from: 'sensor.solar' }] }], device_consumption: [{ stat_consumption: 'sensor:ext' }] },
  });
  assert.ok(p.entities.has('sensor.grid_in') && p.entities.has('sensor.solar'));
  assert.ok(p.statistics.has('sensor:ext'));
});

test('publicationFor: by host, or the only publication', () => {
  const a = { hostname: 'a.example.com', dashboard: 'd', view: 'v', noindex: true };
  const b = { hostname: 'b.example.com', dashboard: 'd', view: 'w', noindex: true };
  assert.equal(publicationFor([a, b], 'B.example.com:443'), b);
  assert.equal(publicationFor([a, b], 'other.com'), undefined);
  assert.equal(publicationFor([a, b], 'x', 'a.example.com, proxy'), a);
  assert.equal(publicationFor([a], 'anything'), a);
});
