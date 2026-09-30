import WebSocket from 'ws';

// Home Assistant only accepts http client ids for loopback and private addresses.
export const CLIENT_ID = 'http://localhost:8099/';
export const REDIRECT_URI = `${CLIENT_ID}?auth_callback=1`;

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** Credentials were refused. Distinct from "Core is unreachable", so callers can back off. */
export class AuthError extends Error {}

export function wsUrl(haUrl: string): string {
  return `${haUrl.replace(/^http/, 'ws')}/api/websocket`;
}

async function tokenRequest(haUrl: string, body: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${haUrl}/auth/token`, { method: 'POST', body: new URLSearchParams(body) });
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new AuthError(`token request refused (${r.status})`);
  if (!r.ok) throw new Error(`token request failed (${r.status})`);
  return (await r.json()) as Tokens;
}

export function refreshAccessToken(haUrl: string, refreshToken: string): Promise<Tokens> {
  return tokenRequest(haUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
}

export async function login(haUrl: string, username: string, password: string): Promise<Tokens> {
  const json = { 'content-type': 'application/json' };
  const start = await fetch(`${haUrl}/auth/login_flow`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_id: CLIENT_ID, handler: ['homeassistant', null], redirect_uri: REDIRECT_URI }),
  });
  if (!start.ok) throw new Error(`login flow failed to start (${start.status})`);
  const flow = (await start.json()) as { flow_id: string };
  const step = await fetch(`${haUrl}/auth/login_flow/${flow.flow_id}`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_id: CLIENT_ID, username, password }),
  });
  const body = (await step.json()) as { type: string; result?: string };
  if (body.type !== 'create_entry' || !body.result) throw new AuthError(`login refused for ${username}`);
  return tokenRequest(haUrl, { grant_type: 'authorization_code', code: body.result, client_id: CLIENT_ID });
}

export interface ResultMessage {
  id: number;
  type: 'result';
  success: boolean;
  result?: any;
  error?: { code: string; message: string };
}

/** Promise-based websocket to Core. Used for short admin and metadata calls, not for visitors. */
export class HaSocket {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, (m: ResultMessage) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'result') this.#pending.get(m.id)?.(m);
    });
  }

  /** `url` is the full websocket URL; `token` is an access token (or the Supervisor token). */
  static async connect(url: string, token: string): Promise<HaSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', function handshake(raw) {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (m.type === 'auth_ok') { ws.off('message', handshake); resolve(); }
        else if (m.type === 'auth_invalid') reject(new AuthError(`websocket auth refused: ${m.message}`));
      });
    });
    return new HaSocket(ws);
  }

  request(type: string, payload: Record<string, unknown> = {}): Promise<ResultMessage> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`timeout: ${type}`)); }, 20000);
      this.#pending.set(id, (m) => { clearTimeout(timer); this.#pending.delete(id); resolve(m); });
      this.#ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  /** Like request, but throws when Core answers success:false. */
  async call<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const m = await this.request(type, payload);
    if (!m.success) throw new Error(`${type} failed: ${m.error?.code} ${m.error?.message}`);
    return m.result as T;
  }

  close(): void { this.#ws.close(); }
}
