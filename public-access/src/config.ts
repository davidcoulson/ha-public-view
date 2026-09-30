import { existsSync, readFileSync } from 'node:fs';

export interface Publication {
  /** Host header this publication answers to. With a single publication, any host matches. */
  hostname: string;
  /** Dashboard url_path as shown in Settings > Dashboards. "lovelace" means the default dashboard. */
  dashboard: string;
  /** View "path" (the URL field in the view's settings). */
  view: string;
  title?: string;
  noindex: boolean;
}

export interface Limits {
  /** Live visitor websockets, in total and per visitor address. */
  maxSessions: number;
  maxSessionsPerVisitor: number;
  /** Page, history and websocket-connect requests per visitor address per minute. */
  requestsPerMinute: number;
  /** Static file requests per visitor address per minute. */
  staticPerMinute: number;
  /** Websocket messages from one visitor per 10 seconds before the connection is closed. */
  messagesPer10s: number;
}

export interface Config {
  port: number;
  /** Base URL of Home Assistant Core, e.g. http://homeassistant:8123 */
  haUrl: string;
  dataDir: string;
  logLevel?: string;
  /** Seed for a fresh install; the setup page owns the list afterwards (see publications.ts). */
  publications: Publication[];
  /** Port of the setup page (the add-on's ingress port). 0 disables it. */
  uiPort: number;
  /** Peers allowed to reach the setup page. The Supervisor's address inside an add-on. */
  uiAllowedPeers: string[] | 'any';
  limits: Limits;
  /** Development only: an owner account used to create the viewer user. */
  admin?: { username: string; password: string };
  /** Set by the Supervisor inside an add-on; preferred way to create the viewer user. */
  supervisorToken?: string;
}

interface RawOptions {
  ha_url?: string;
  log_level?: string;
  max_sessions?: number;
  max_sessions_per_visitor?: number;
  publications?: Array<Partial<Publication> & { noindex?: boolean }>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.PA_OPTIONS_FILE ?? (existsSync('/data/options.json') ? '/data/options.json' : undefined);
  const raw: RawOptions = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const haUrl = (env.HA_URL ?? raw.ha_url ?? 'http://homeassistant:8123').replace(/\/$/, '');
  const publications = (raw.publications ?? []).map((p, i) => {
    if (!p.hostname || !p.dashboard || !p.view) {
      throw new Error(`publications[${i}] needs hostname, dashboard and view`);
    }
    return {
      hostname: p.hostname.toLowerCase(),
      dashboard: p.dashboard,
      view: String(p.view),
      title: p.title,
      noindex: p.noindex ?? true,
    } satisfies Publication;
  });
  return {
    port: Number(env.PORT ?? 8099),
    haUrl,
    dataDir: env.DATA_DIR ?? '/data',
    logLevel: env.LOG_LEVEL ?? raw.log_level,
    publications,
    uiPort: Number(env.UI_PORT ?? 8100),
    uiAllowedPeers: env.PA_UI_ALLOW_ANY === '1' ? 'any' : ['172.30.32.2', '::ffff:172.30.32.2'],
    limits: {
      maxSessions: raw.max_sessions ?? 50,
      maxSessionsPerVisitor: raw.max_sessions_per_visitor ?? 6,
      requestsPerMinute: 120,
      staticPerMinute: 1200,
      messagesPer10s: 1500,
    },
    admin: env.PA_ADMIN_USER ? { username: env.PA_ADMIN_USER, password: env.PA_ADMIN_PASS ?? '' } : undefined,
    supervisorToken: env.SUPERVISOR_TOKEN,
  };
}
