// Needs the app running with the ESPHome device enabled AND already added to Home Assistant
// (the setup panel's "Add to Home Assistant" button, or POST :8100/api/esphome/adopt).
// Checks the device from Home Assistant's side: entities exist, monitoring moves, and config entities
// really change what the public side does.
import WebSocket from 'ws';
import { HaSocket, login, wsUrl } from '../../src/core/client.ts';

const BASE = process.env.RELAY_URL ?? 'http://localhost:8099';
const HA_URL = process.env.HA_URL ?? 'http://localhost:8123';
const results: Array<{ name: string; ok: boolean; got: string }> = [];
const check = (name: string, ok: boolean, got: unknown = '') => results.push({ name, ok, got: String(got) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tokens = await login(HA_URL, process.env.PA_ADMIN_USER ?? 'admin', process.env.PA_ADMIN_PASS ?? 'admin-dev-password');
const ha = await HaSocket.connect(wsUrl(HA_URL), tokens.access_token);
type State = { entity_id: string; state: string; attributes: Record<string, any> };
const states = async () => (await ha.call<State[]>('get_states')).filter((s) => s.entity_id.includes('public_access'));
const find = async (domain: string, suffix: string) => (await states()).find((s) => s.entity_id.startsWith(`${domain}.`) && s.entity_id.endsWith(suffix));
const until = async (fn: () => Promise<boolean>, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(300); } return false; };
const call = (domain: string, service: string, entity: string, data: Record<string, unknown> = {}) =>
  ha.call('call_service', { domain, service, service_data: data, target: { entity_id: entity } });
const status = async (path = '/') => (await fetch(BASE + path)).status;
const tryOpen = (): Promise<{ ok: boolean; status?: number; ws?: WebSocket }> => new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/websocket`);
  ws.on('open', () => resolve({ ok: true, ws }));
  ws.on('unexpected-response', (_q, r) => resolve({ ok: false, status: r.statusCode }));
  ws.on('error', () => undefined);
});

try {
  const before = await states();
  check('Home Assistant shows the device\'s entities', before.length >= 14, `${before.length} entities`);
  const serve = await find('switch', 'serve_visitors');
  const maxV = await find('number', 'most_visitors');
  const disconnect = await find('button', 'disconnect_all_visitors');
  const pubSwitch = before.find((s) => s.entity_id.startsWith('switch.') && s.entity_id.includes('publish_'));
  check('has the serve switch, limits number, disconnect button and a per-publication switch', !!(serve && maxV && disconnect && pubSwitch), before.map((s) => s.entity_id).join(' '));
  if (!serve || !maxV || !disconnect || !pubSwitch) throw new Error('entities missing');

  const statusText = await find('sensor', '_status');
  check('Status sensor reads "Serving …"', !!statusText && statusText.state.startsWith('Serving'), statusText?.state);
  const link = await find('binary_sensor', 'home_assistant_link');
  check('Home Assistant link is on', link?.state === 'on', link?.state);

  // monitoring moves
  const visitsBefore = Number((await find('sensor', '_visits'))!.state);
  const a = await tryOpen();
  check('a visitor can connect', a.ok);
  const moved = await until(async () => Number((await find('sensor', '_visitors'))!.state) >= 1 && Number((await find('sensor', '_visits'))!.state) > visitsBefore);
  check('Visitors and Visits sensors move when a visitor connects', moved);
  a.ws?.close();

  // button: disconnect
  const b = await tryOpen();
  let closed = false; b.ws?.on('close', () => { closed = true; });
  await call('button', 'press', disconnect.entity_id);
  check('the Disconnect button closes live visitors', await until(async () => closed, 6000));

  // number: limits
  await call('number', 'set_value', maxV.entity_id, { value: 1 });
  await sleep(1200);
  const c1 = await tryOpen(); const c2 = await tryOpen();
  check('Most visitors = 1 admits one and refuses the next (503)', c1.ok && !c2.ok && c2.status === 503, `${c1.ok} / ${c2.status}`);
  c1.ws?.close();
  await call('number', 'set_value', maxV.entity_id, { value: 50 });

  // switch: pause
  await call('switch', 'turn_off', serve.entity_id);
  check('Serve visitors off: public page answers 503', await until(async () => (await status()) === 503, 6000), await status());
  const d = await tryOpen();
  check('Serve visitors off: websocket refused', !d.ok && d.status === 503, d.status);
  check('Status sensor says Paused', await until(async () => (await find('sensor', '_status'))?.state === 'Paused', 8000));
  await call('switch', 'turn_on', serve.entity_id);
  check('Serve visitors on: page is back', await until(async () => (await status()) === 200, 6000), await status());

  // per-publication switch
  await call('switch', 'turn_off', pubSwitch.entity_id);
  check('Publish <host> off: that address answers 404', await until(async () => (await status()) === 404, 6000), await status());
  await call('switch', 'turn_on', pubSwitch.entity_id);
  check('Publish <host> on: page is back', await until(async () => (await status()) === 200, 6000), await status());
} catch (e) {
  check('test ran to the end', false, (e as Error).message);
} finally {
  ha.close();
}

for (const r of results) console.log(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.name}${r.ok ? '' : `\n        got: ${r.got}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
