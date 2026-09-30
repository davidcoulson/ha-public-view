// Dev only: onboards a fresh Home Assistant if needed and creates a dashboard with a public view
// ("solar") and a private one, so there is something to publish and something that must not leak.
import { CLIENT_ID, HaSocket, REDIRECT_URI, login, wsUrl } from '../src/core/client.ts';

const HA_URL = (process.env.HA_URL ?? 'http://localhost:8123').replace(/\/$/, '');
const USER = process.env.PA_ADMIN_USER ?? 'admin';
const PASS = process.env.PA_ADMIN_PASS ?? 'admin-dev-password';

async function onboard(): Promise<void> {
  const r = await fetch(`${HA_URL}/api/onboarding`);
  if (!r.ok) return;
  const steps = (await r.json()) as Array<{ step: string; done: boolean }>;
  if (steps.find((s) => s.step === 'user')?.done) return;
  const json = { 'content-type': 'application/json' };
  const u = await fetch(`${HA_URL}/api/onboarding/users`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ client_id: CLIENT_ID, name: 'Admin', username: USER, password: PASS, language: 'en' }),
  });
  const { auth_code } = (await u.json()) as { auth_code: string };
  const t = await fetch(`${HA_URL}/auth/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: auth_code, client_id: CLIENT_ID }),
  });
  const { access_token } = (await t.json()) as { access_token: string };
  const auth = { ...json, authorization: `Bearer ${access_token}` };
  for (const [step, body] of [['core_config', {}], ['analytics', {}], ['integration', { client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }]] as const) {
    await fetch(`${HA_URL}/api/onboarding/${step}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  }
}

export const DASHBOARD = 'public-test';

export async function seed(): Promise<void> {
  await onboard();
  const tokens = await login(HA_URL, USER, PASS);
  const ws = await HaSocket.connect(wsUrl(HA_URL), tokens.access_token);
  try {
    const existing = await ws.call<Array<{ url_path: string }>>('lovelace/dashboards/list');
    if (!existing.some((d) => d.url_path === DASHBOARD)) {
      await ws.call('lovelace/dashboards/create', { url_path: DASHBOARD, title: 'Public test', icon: 'mdi:eye', show_in_sidebar: true, require_admin: false, mode: 'storage' });
    }
    await ws.call('lovelace/config/save', {
      url_path: DASHBOARD,
      config: {
        title: 'Public test',
        views: [
          {
            path: 'solar', title: 'Solar',
            cards: [
              { type: 'entities', title: 'Outside', entities: ['sensor.outside_temperature', 'sensor.outside_humidity'] },
              { type: 'history-graph', title: 'Temperature', hours_to_show: 6, entities: ['sensor.outside_temperature'] },
              { type: 'markdown', content: "It is {{ states('sensor.outside_temperature') }} degrees outside." },
              { type: 'gauge', entity: 'sensor.carbon_dioxide', name: 'CO2' },
              { type: 'tile', entity: 'light.bed_light' },
            ],
          },
          {
            path: 'private', title: 'Private',
            cards: [{ type: 'entities', title: 'Secrets', entities: ['lock.front_door', 'climate.hvac', 'sensor.power_consumption'] }],
          },
        ],
      },
    });
  } finally { ws.close(); }
  console.log(`Seeded dashboard "${DASHBOARD}" with views solar (public) and private`);
}

if (import.meta.main) await seed();
