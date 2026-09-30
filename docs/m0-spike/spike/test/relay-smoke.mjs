// Talks to the PUBLIC side (default :8099) exactly as a hostile visitor would.
// Run while the spike is up:  node test/relay-smoke.mjs   (inside the container: docker compose exec spike node test/relay-smoke.mjs)
import WebSocket from 'ws';

const url = (process.env.RELAY_URL ?? 'ws://localhost:8099') + '/api/websocket';
const ws = new WebSocket(url);
const waiting = new Map();
let n = 1;
const results = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: 'not-a-real-token' }));
  else if (m.type === 'auth_ok') run();
  else waiting.get(m.id)?.(m);
});
const ask = (msg) => new Promise((resolve) => { const id = n++; waiting.set(id, resolve); ws.send(JSON.stringify({ id, ...msg })); });
const expectRefused = async (label, msg) => {
  const r = await ask(msg);
  results.push({ label, ok: r.success === false, got: r.success ? 'ACCEPTED' : r.error?.code });
};

async function run() {
  await expectRefused('call_service light.turn_on', { type: 'call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.bed_light' } });
  await expectRefused('call_service persistent_notification.create (not blocked by read-only group)', { type: 'call_service', domain: 'persistent_notification', service: 'create', service_data: { message: 'pwned' } });
  await expectRefused('call_service homeassistant.restart', { type: 'call_service', domain: 'homeassistant', service: 'restart' });
  await expectRefused('config/auth/list', { type: 'config/auth/list' });
  await expectRefused('render_template of a string not in the view', { type: 'render_template', template: '{{ states | list }}' });
  await expectRefused('fire_event', { type: 'fire_event', event_type: 'x' });
  await expectRefused('unknown type', { type: 'totally/made_up' });
  const cfg = await ask({ type: 'get_config' });
  results.push({ label: 'get_config location redacted', ok: cfg.success && cfg.result.latitude === 0 && cfg.result.longitude === 0 && cfg.result.config_dir === null, got: JSON.stringify({ lat: cfg.result?.latitude, lon: cfg.result?.longitude, dir: cfg.result?.config_dir }) });
  const st = await ask({ type: 'get_states' });
  results.push({ label: 'get_states works (reads pass)', ok: st.success && st.result.length > 0, got: `${st.result?.length} states` });
  for (const r of results) console.log(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.label}  -> ${r.got}`);
  ws.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
