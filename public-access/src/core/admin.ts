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
