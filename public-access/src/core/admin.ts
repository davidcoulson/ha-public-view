import type { Config } from '../config.ts';
import { HaSocket, login, wsUrl } from './client.ts';

/**
 * An administrator connection to Core. Only for setup work (creating the viewer, listing dashboards
 * in the setup page); never used on behalf of a visitor.
 * Inside an add-on this is the Supervisor's proxy; in development it is a login with PA_ADMIN_*.
 */
export async function adminSocket(config: Config): Promise<HaSocket> {
  if (config.supervisorToken) return HaSocket.connect('ws://supervisor/core/websocket', config.supervisorToken);
  if (config.admin) {
    const tokens = await login(config.haUrl, config.admin.username, config.admin.password);
    return HaSocket.connect(wsUrl(config.haUrl), tokens.access_token);
  }
  throw new Error('No way to reach Core as an administrator: run as an add-on, or set PA_ADMIN_USER and PA_ADMIN_PASS');
}

/** A REST call to Core as an administrator (config flows are REST-only). Returns the parsed JSON body. */
export async function coreRest(config: Config, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  let base: string;
  let token: string;
  if (config.supervisorToken) {
    base = 'http://supervisor/core/api';
    token = config.supervisorToken;
  } else if (config.admin) {
    base = `${config.haUrl}/api`;
    token = (await login(config.haUrl, config.admin.username, config.admin.password)).access_token;
  } else {
    throw new Error('No way to reach Core as an administrator');
  }
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
