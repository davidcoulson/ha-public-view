// The public websocket: pretends to be Home Assistant to the browser, and relays
// only allowlisted message types to the real one as the read-only viewer.
import { WebSocketServer, WebSocket } from 'ws';
import { refreshAccessToken } from './ha.mjs';

// Seeded with the obvious reads. Everything the frontend asks for beyond this shows up in
// /m0/refused, and gets added here only after deciding it is safe. That is how the real
// list is discovered without copying anyone else's.
export const ALLOWED = new Set([
  'ping', 'supported_features', 'auth/current_user',
  'get_config', 'get_services', 'get_panels', 'get_states', 'subscribe_entities',
  'subscribe_events', 'unsubscribe_events',
  'frontend/get_themes', 'frontend/get_translations', 'frontend/get_user_data',
  'frontend/subscribe_user_data', 'frontend/subscribe_system_data', 'frontend/get_icons',
  'lovelace/config', 'lovelace/info', 'lovelace/resources',
  'config/area_registry/list', 'config/floor_registry/list', 'config/label_registry/list',
  'config/device_registry/list', 'config/entity_registry/list_for_display',
  'recorder/info', 'sensor/numeric_device_classes',
]);

// Answered locally with an empty success, so the frontend gets an answer without
// the owner's repair issues or notifications ever leaving Home Assistant.
const QUIET = { 'repairs/list_issues': { issues: [] }, 'persistent_notification/subscribe': null };
const EVENT_TYPES = new Set(['state_changed', 'core_config_updated', 'themes_updated', 'panels_updated', 'lovelace_updated']);

export const stats = { refused: {}, quiet: {}, forwarded: {}, sessions: 0, active: 0 };
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

export function attachRelay(server, { haUrl, viewerRefreshToken }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/api/websocket') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onVisitor(ws));
  });

  async function onVisitor(visitor) {
    stats.sessions++; stats.active++;
    visitor.on('close', () => { stats.active--; upstream?.close(); });
    const send = (o) => visitor.readyState === WebSocket.OPEN && visitor.send(JSON.stringify(o));
    const types = new Map(); // message id -> type, for filtering replies
    let upstream;
    let ready;

    send({ type: 'auth_required', ha_version: '0.0-public' });

    visitor.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const items = Array.isArray(data) ? data : [data];
      for (const msg of items) {
        if (msg.type === 'auth') {
          // Accepts anything: this endpoint is public by design and authenticates nobody.
          send({ type: 'auth_ok', ha_version: '0.0-public' });
          ready = connectUpstream();
          continue;
        }
        await ready;
        handle(msg);
      }
    });

    async function connectUpstream() {
      const token = await refreshAccessToken(haUrl, viewerRefreshToken);
      upstream = new WebSocket(`${haUrl.replace(/^http/, 'ws')}/api/websocket`);
      await new Promise((resolve, reject) => {
        upstream.on('error', reject);
        upstream.on('message', function first(raw) {
          const m = JSON.parse(raw);
          if (m.type === 'auth_required') upstream.send(JSON.stringify({ type: 'auth', access_token: token }));
          else if (m.type === 'auth_ok') { upstream.off('message', first); resolve(); }
          else if (m.type === 'auth_invalid') reject(new Error(m.message));
        });
      });
      upstream.on('message', (raw) => fromUpstream(JSON.parse(raw)));
      upstream.on('close', () => visitor.close());
    }

    function refuse(id, why = 'Read-only public view') {
      send({ id, type: 'result', success: false, error: { code: 'unauthorized', message: why } });
    }

    function handle(msg) {
      const { id, type } = msg;
      if (typeof id === 'number' && type in QUIET) {
        bump(stats.quiet, type);
        send({ id, type: 'result', success: true, result: QUIET[type] });
        return;
      }
      if (typeof id !== 'number' || !ALLOWED.has(type)) {
        bump(stats.refused, type === 'call_service' ? `call_service:${msg.domain}.${msg.service}` : String(type));
        if (typeof id === 'number') refuse(id);
        return;
      }
      if (type === 'subscribe_events' && !EVENT_TYPES.has(msg.event_type ?? '*')) {
        bump(stats.refused, `subscribe_events:${msg.event_type ?? '*'}`);
        send({ id, type: 'result', success: true, result: null }); // silent: never fires
        return;
      }
      bump(stats.forwarded, type);
      types.set(id, type);
      upstream.send(JSON.stringify(msg));
    }

    function fromUpstream(m) {
      const type = types.get(m.id);
      if (type === 'get_config' && m.type === 'result' && m.success) {
        // Do better than "pass through": the browser does not need the home's real location.
        for (const k of ['latitude', 'longitude', 'elevation', 'config_dir', 'external_url', 'internal_url', 'allowlist_external_dirs', 'allowlist_external_urls']) {
          if (k in m.result) m.result[k] = Array.isArray(m.result[k]) ? [] : (typeof m.result[k] === 'number' ? 0 : null);
        }
      }
      send(m);
    }
  }
}
