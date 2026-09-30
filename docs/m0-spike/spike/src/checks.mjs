// The M0 questions, asked of a real Home Assistant.
import WebSocket from 'ws';
import { createConnection, createLongLivedTokenAuth, subscribeEntities } from 'home-assistant-js-websocket';
import { HaSocket, login, refreshAccessToken } from './ha.mjs';

const PASSWORD = 'm0-Viewer-password-0123456789abcdef';

async function recreateUser(admin, name, groupIds) {
  const list = await admin.request('config/auth/list');
  for (const u of list.result ?? []) {
    if (u.name === name) await admin.request('config/auth/delete', { user_id: u.id });
  }
  const created = await admin.request('config/auth/create', { name, group_ids: groupIds, local_only: true });
  if (!created.success) return { created };
  const userId = created.result.user.id;
  const cred = await admin.request('config/auth_provider/homeassistant/create', {
    user_id: userId, username: name, password: PASSWORD,
  });
  return { created, cred, userId };
}

// Adapter so home-assistant-js-websocket can run on Node's `ws`.
// The library calls createSocket(options) and expects back a socket that has already authenticated.
function nodeCreateSocket(base) {
  return (options) => new Promise((resolve, reject) => {
    const auth = options.auth;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/websocket`);
    ws.on('error', reject);
    ws.on('message', function handshake(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: auth.accessToken }));
      else if (m.type === 'auth_ok') { ws.off('message', handshake); ws.haVersion = m.ha_version; resolve(ws); }
      else if (m.type === 'auth_invalid') reject(new Error(m.message));
    });
  });
}

export async function runChecks(base, adminTokens) {
  const results = [];
  const add = (id, title, ok, detail) => { results.push({ id, title, ok, detail }); };
  const admin = await HaSocket.connect(base, adminTokens.access_token);

  // C1/C2: can an add-on create a *normal* user inside system-read-only?
  const ro = await recreateUser(admin, 'm0-viewer', ['system-read-only']);
  const roGroups = ro.created?.result?.user?.group_ids;
  add('C1', 'config/auth/create accepts group system-read-only for a normal user',
    !!ro.created?.success && roGroups?.includes('system-read-only'),
    ro.created?.success ? `groups: ${JSON.stringify(roGroups)}` : JSON.stringify(ro.created?.error));
  if (!ro.userId) { admin.close(); return { results, viewer: null }; }
  add('C2', 'local password credential can be added to that user', !!ro.cred?.success, JSON.stringify(ro.cred?.error ?? 'ok'));

  // Control user: same thing but in the ordinary non-admin group.
  const ctl = await recreateUser(admin, 'm0-writer', ['system-users']);

  // C3: log in as the viewer with the password, keep the refresh token.
  let viewerTokens;
  try {
    viewerTokens = await login(base, 'm0-viewer', PASSWORD);
    add('C3', 'add-on can log in as the viewer and obtain a refresh token', true, `expires_in ${viewerTokens.expires_in}s`);
  } catch (e) {
    add('C3', 'add-on can log in as the viewer and obtain a refresh token', false, String(e.message));
    admin.close();
    return { results, viewer: null };
  }
  const viewer = await HaSocket.connect(base, viewerTokens.access_token);

  // C4: what the viewer can and cannot do.
  const states = await viewer.request('get_states');
  add('C4a', 'viewer can read states', !!states.success && states.result.length > 0, `${states.result?.length ?? 0} states visible`);
  const demoLight = states.result?.find((s) => s.entity_id.startsWith('light.'))?.entity_id ?? 'light.bed_light';
  const svc = await viewer.request('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: demoLight } });
  add('C4b', 'viewer is refused a service call (light.turn_on)', svc.success === false, svc.success ? 'SERVICE CALL WAS ACCEPTED' : `${svc.error?.code}: ${svc.error?.message}`);
  const svc2 = await viewer.request('call_service', { domain: 'persistent_notification', service: 'create', service_data: { message: 'x' } });
  add('C4c', 'viewer is refused a service that targets no entity (persistent_notification.create)', svc2.success === false, svc2.success ? 'SERVICE CALL WAS ACCEPTED' : `${svc2.error?.code}: ${svc2.error?.message}`);
  const authList = await viewer.request('config/auth/list');
  add('C4d', 'viewer cannot list users', authList.success === false, authList.success ? 'LISTED USERS' : authList.error?.code);

  // C5: control. Does an ordinary user need the read-only group to be safe?
  if (ctl.userId) {
    try {
      const ct = await login(base, 'm0-writer', PASSWORD);
      const w = await HaSocket.connect(base, ct.access_token);
      const wr = await w.request('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: demoLight } });
      add('C5', 'control: an ordinary non-admin user CAN call services (shows lock 2 matters)', wr.success === true, wr.success ? 'accepted, as expected' : `refused: ${wr.error?.code}`);
      w.close();
      await admin.request('call_service', { domain: 'light', service: 'turn_off', target: { entity_id: demoLight } });
    } catch (e) {
      add('C5', 'control user check', false, String(e.message));
    }
  }

  // C6: home-assistant-js-websocket on Node.
  try {
    const auth = createLongLivedTokenAuth(base, viewerTokens.access_token);
    const conn = await createConnection({ auth, createSocket: nodeCreateSocket(base) });
    const seen = await new Promise((resolve) => {
      const unsub = subscribeEntities(conn, (e) => { unsub(); resolve(Object.keys(e).length); });
    });
    conn.close();
    add('C6', 'home-assistant-js-websocket runs on Node with a `ws` socket', seen > 0, `subscribeEntities delivered ${seen} entities`);
  } catch (e) {
    add('C6', 'home-assistant-js-websocket runs on Node with a `ws` socket', false, String(e.stack ?? e));
  }

  // C7: what a viewer can see that the plan flagged as possibly too much.
  const probe = async (type, extra) => {
    const r = await viewer.request(type, extra);
    return r.success ? r.result : { __refused: r.error?.code };
  };
  const cfg = await probe('get_config');
  add('C7a', 'INFO get_config reveals home location to the viewer', null,
    cfg.__refused ? `refused (${cfg.__refused})` : `latitude=${cfg.latitude} longitude=${cfg.longitude} elevation=${cfg.elevation} config_dir=${cfg.config_dir} external_url=${cfg.external_url}`);
  for (const t of ['config/device_registry/list', 'config/area_registry/list', 'config/entity_registry/list', 'manifest/list', 'get_services']) {
    const r = await probe(t);
    add(`C7-${t}`, `INFO viewer may call ${t}`, null, r.__refused ? `refused (${r.__refused})` : `allowed, ${Array.isArray(r) ? r.length : Object.keys(r).length} items`);
  }

  viewer.close();
  admin.close();
  return { results, viewer: { refreshToken: viewerTokens.refresh_token, demoLight } };
}

export { refreshAccessToken };
