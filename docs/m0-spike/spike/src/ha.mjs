// Small Home Assistant client helpers: onboarding, login, and a promise-based websocket.
import WebSocket from 'ws';

export const CLIENT_ID = 'http://localhost:8099/';
export const REDIRECT_URI = `${CLIENT_ID}?auth_callback=1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForHa(base, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${base}/manifest.json`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`Home Assistant did not come up at ${base}`);
    await sleep(2000);
  }
}

const form = (o) => new URLSearchParams(o);

export async function exchangeCode(base, code) {
  const r = await fetch(`${base}/auth/token`, {
    method: 'POST',
    body: form({ grant_type: 'authorization_code', code, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, expires_in, ... }
}

export async function refreshAccessToken(base, refreshToken) {
  const r = await fetch(`${base}/auth/token`, {
    method: 'POST',
    body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

export async function login(base, username, password) {
  const start = await fetch(`${base}/auth/login_flow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, handler: ['homeassistant', null], redirect_uri: REDIRECT_URI }),
  });
  if (!start.ok) throw new Error(`login_flow start failed: ${start.status} ${await start.text()}`);
  const flow = await start.json();
  const step = await fetch(`${base}/auth/login_flow/${flow.flow_id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, username, password }),
  });
  const body = await step.json();
  if (body.type !== 'create_entry') throw new Error(`login failed for ${username}: ${JSON.stringify(body)}`);
  return exchangeCode(base, body.result);
}

// Returns tokens for the admin, creating the owner account on a fresh instance.
export async function ensureAdmin(base, username, password) {
  const ob = await fetch(`${base}/api/onboarding`);
  if (ob.ok) {
    const steps = await ob.json();
    const done = (name) => steps.find((s) => s.step === name)?.done;
    if (!done('user')) {
      const r = await fetch(`${base}/api/onboarding/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, name: 'Admin', username, password, language: 'en' }),
      });
      if (!r.ok) throw new Error(`onboarding user failed: ${r.status} ${await r.text()}`);
      const tokens = await exchangeCode(base, (await r.json()).auth_code);
      const auth = { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' };
      for (const [step, body] of [
        ['core_config', {}],
        ['analytics', {}],
        ['integration', { client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }],
      ]) {
        const s = await fetch(`${base}/api/onboarding/${step}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
        if (!s.ok) console.warn(`onboarding step ${step}: ${s.status}`);
      }
    }
  }
  return login(base, username, password);
}

// Promise-based websocket to Home Assistant, authenticated with an access token.
export class HaSocket {
  static async connect(base, accessToken) {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/websocket`);
    const sock = new HaSocket(ws);
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', function first(raw) {
        const m = JSON.parse(raw);
        if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }));
        else if (m.type === 'auth_ok') { ws.off('message', first); resolve(); }
        else if (m.type === 'auth_invalid') reject(new Error(`auth_invalid: ${m.message}`));
      });
    });
    ws.on('message', (raw) => sock.#onMessage(JSON.parse(raw)));
    return sock;
  }

  #id = 1;
  #pending = new Map();
  constructor(ws) { this.ws = ws; }

  #onMessage(m) {
    const p = this.#pending.get(m.id);
    if (p && m.type === 'result') { this.#pending.delete(m.id); p(m); }
  }

  // Resolves with the full result message; never rejects on success:false.
  request(type, payload = {}) {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 15000);
      this.#pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close() { this.ws.close(); }
}
