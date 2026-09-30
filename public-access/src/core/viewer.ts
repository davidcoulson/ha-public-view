import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { adminSocket } from './admin.ts';
import { AuthError, login, refreshAccessToken } from './client.ts';
import { log } from '../log.ts';

const VIEWER_NAME = 'Public Access viewer';
const READ_ONLY_GROUP = 'system-read-only';
/** After a refused login, do not try again for this long. Repeated failures get this address banned by Core. */
const RETRY_AFTER_FAILURE_MS = 30_000;

interface Stored { username: string; password: string; refreshToken: string }

/**
 * The one Core identity used for everything a visitor causes. A normal user in the
 * read-only group, local_only so it cannot log in from outside, with a random password
 * kept in the add-on's private data directory.
 */
export class Viewer {
  #config: Config;
  #file: string;
  #stored?: Stored;
  #access?: { token: string; expiresAt: number };
  #failedAt = 0;
  #inflight?: Promise<string>;

  constructor(config: Config) {
    this.#config = config;
    this.#file = join(config.dataDir, 'viewer.json');
  }

  /** Make sure a working viewer exists; create it if not. Call once at startup. */
  async ensure(): Promise<void> {
    this.#stored = await this.#read();
    if (this.#stored) {
      try { await this.accessToken(); log.info('Viewer user is ready'); return; }
      catch (e) { log.warn(`Stored viewer does not work (${(e as Error).message}); creating a new one`); }
    }
    await this.#provision();
    this.#failedAt = 0; // the back-off was for the old credentials
    this.#access = undefined;
    await this.accessToken();
    log.info('Created the read-only viewer user');
  }

  /** A valid access token for the viewer, refreshed when close to expiry. */
  accessToken(): Promise<string> {
    if (this.#access && this.#access.expiresAt - Date.now() > 60_000) return Promise.resolve(this.#access.token);
    this.#inflight ??= this.#renew().finally(() => { this.#inflight = undefined; });
    return this.#inflight;
  }

  async #renew(): Promise<string> {
    const stored = this.#stored;
    if (!stored) throw new Error('viewer is not provisioned');
    if (Date.now() - this.#failedAt < RETRY_AFTER_FAILURE_MS) throw new Error('waiting before retrying a refused login');
    const { haUrl } = this.#config;
    try {
      let tokens;
      try {
        tokens = await refreshAccessToken(haUrl, stored.refreshToken);
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        // The refresh token was revoked; the stored password is the fallback.
        const fresh = await login(haUrl, stored.username, stored.password);
        stored.refreshToken = fresh.refresh_token ?? stored.refreshToken;
        await this.#write(stored);
        tokens = fresh;
      }
      this.#access = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
      return tokens.access_token;
    } catch (e) {
      if (e instanceof AuthError) this.#failedAt = Date.now();
      throw e;
    }
  }

  async #provision(): Promise<void> {
    const { haUrl } = this.#config;
    const admin = await adminSocket(this.#config);
    try {
      const users = await admin.call<Array<{ id: string; name: string }>>('config/auth/list');
      for (const u of users) if (u.name === VIEWER_NAME) await admin.call('config/auth/delete', { user_id: u.id });
      const created = await admin.call<{ user: { id: string; group_ids: string[] } }>('config/auth/create', {
        name: VIEWER_NAME, group_ids: [READ_ONLY_GROUP], local_only: true,
      });
      // Never run with a viewer that can do more than read.
      if (created.user.group_ids.length !== 1 || created.user.group_ids[0] !== READ_ONLY_GROUP) {
        await admin.call('config/auth/delete', { user_id: created.user.id });
        throw new Error(`Core did not put the viewer in ${READ_ONLY_GROUP}: ${created.user.group_ids.join(',')}`);
      }
      const username = `public-access-${randomBytes(4).toString('hex')}`;
      const password = randomBytes(32).toString('base64url');
      await admin.call('config/auth_provider/homeassistant/create', { user_id: created.user.id, username, password });
      const tokens = await login(haUrl, username, password);
      this.#stored = { username, password, refreshToken: tokens.refresh_token! };
      await this.#write(this.#stored);
    } finally {
      admin.close();
    }
  }

  async #read(): Promise<Stored | undefined> {
    try { return JSON.parse(await readFile(this.#file, 'utf8')) as Stored; } catch { return undefined; }
  }

  async #write(s: Stored): Promise<void> {
    await mkdir(this.#config.dataDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(s), { mode: 0o600 });
    await chmod(this.#file, 0o600);
  }
}
