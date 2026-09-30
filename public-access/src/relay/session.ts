import WebSocket from 'ws';
import type { Publication } from '../config.ts';
import { wsUrl } from '../core/client.ts';
import type { Viewer } from '../core/viewer.ts';
import { Flood } from '../http/guard.ts';
import { log } from '../log.ts';
import { inbound, outbound, refusalKey, type Ctx, type Msg } from '../policy/filter.ts';
import type { PublishedProvider } from '../policy/published.ts';

export const stats = { sessions: 0, active: 0, refused: {} as Record<string, number>, forwarded: {} as Record<string, number>, rateLimited: 0, refusedTotal: 0 };

/** Every open visitor connection, so the owner can see and cut them. */
const live = new Set<Session>();
export function disconnectAll(reason: string): number {
  const n = live.size;
  for (const s of [...live]) s.close(reason);
  return n;
}
export function visitorsByHost(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of live) out.set(s.host, (out.get(s.host) ?? 0) + 1);
  return out;
}
const bump = (o: Record<string, number>, k: string) => { if (Object.keys(o).length < 200 || k in o) o[k] = (o[k] ?? 0) + 1; };

export function ctxFor(pub: Publication): Ctx {
  return {
    dashboardKey: pub.dashboard,
    dashboardUrlPath: pub.dashboard === 'lovelace' ? null : pub.dashboard,
    viewPath: pub.view,
    title: pub.title,
  };
}

/**
 * One visitor's websocket. To the browser this is Home Assistant; to Home Assistant it is the read-only
 * viewer. Every message passes through policy/filter.ts on the way in and on the way out.
 */
export class Session {
  #visitor: WebSocket;
  #pub: Publication;
  #published: PublishedProvider;
  #viewer: Viewer;
  #haUrl: string;
  #upstream?: WebSocket;
  #upstreamReady?: Promise<void>;
  /** id -> type, so Core's replies can be filtered by what was asked. */
  #types = new Map<number, string>();
  /** Subscriptions answered locally that Core knows nothing about. */
  #silent = new Set<number>();
  #queue: Promise<void> = Promise.resolve();
  #flood: Flood;
  #alive = true;

  constructor(visitor: WebSocket, pub: Publication, published: PublishedProvider, viewer: Viewer, haUrl: string, messagesPer10s: number, onClose: () => void) {
    this.#flood = new Flood(messagesPer10s, 10_000);
    this.#visitor = visitor;
    this.#pub = pub;
    this.#published = published;
    this.#viewer = viewer;
    this.#haUrl = haUrl;
    stats.sessions++; stats.active++;
    live.add(this);
    visitor.on('close', () => { stats.active--; live.delete(this); clearInterval(heartbeat); this.#upstream?.close(); onClose(); });
    // Drop connections that stopped answering, so they stop counting against the caps.
    visitor.on('pong', () => { this.#alive = true; });
    const heartbeat = setInterval(() => {
      if (!this.#alive) return visitor.terminate();
      this.#alive = false;
      visitor.ping();
    }, 30_000);
    visitor.on('error', () => visitor.close());
    this.#send({ type: 'auth_required', ha_version: '0.0-public' });
    visitor.on('message', (raw) => {
      if (!this.#flood.hit()) {
        log.warn('closing a connection that sent too many messages');
        return visitor.close(1008, 'too many messages');
      }
      // One at a time, in order: replies and allowlist lookups must not overtake each other.
      this.#queue = this.#queue.then(() => this.#onVisitor(raw.toString())).catch((e) => log.warn(`session error: ${(e as Error).message}`));
    });
  }

  get host(): string { return this.#pub.hostname; }

  close(reason: string): void { this.#visitor.close(1001, reason.slice(0, 100)); }

  #send(o: unknown): void {
    if (this.#visitor.readyState === WebSocket.OPEN) this.#visitor.send(JSON.stringify(o));
  }

  async #onVisitor(text: string): Promise<void> {
    let data: unknown;
    try { data = JSON.parse(text); } catch { return; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) await this.#handle(item);
  }

  async #handle(msg: any): Promise<void> {
    if (msg?.type === 'auth') {
      // Accepts any token: the endpoint is public by design and identifies nobody.
      this.#send({ type: 'auth_ok', ha_version: '0.0-public' });
      this.#upstreamReady = this.#connectUpstream().catch((e) => {
        log.warn(`upstream connect failed: ${(e as Error).message}`);
        this.#visitor.close(1011, 'unavailable');
      });
      return;
    }
    await this.#upstreamReady;
    if (this.#visitor.readyState !== WebSocket.OPEN || !this.#upstream) return;

    // Silent subscriptions never reached Core, so cancelling one is answered here.
    if (msg?.type === 'unsubscribe_events' && this.#silent.delete(msg.subscription)) {
      return this.#send({ id: msg.id, type: 'result', success: true, result: null });
    }
    const pub = await this.#published.get();
    const d = inbound(msg, pub, ctxFor(this.#pub));
    if (d.kind === 'refuse') {
      bump(stats.refused, refusalKey(msg));
      stats.refusedTotal++;
      log.debug(`refused ${refusalKey(msg)}: ${d.reason}`);
      if (typeof msg?.id === 'number') this.#send({ id: msg.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'Read-only public view' } });
      return;
    }
    if (d.kind === 'reply') {
      // Anything subscription-like answered here never reached Core, so its cancellation is answered here too.
      if (d.silentSubscription || /subscribe|stream/.test(msg.type)) this.#silent.add(msg.id);
      return this.#send({ id: msg.id, type: 'result', success: true, result: d.result });
    }
    bump(stats.forwarded, d.msg.type);
    this.#types.set(d.msg.id, d.msg.type);
    this.#upstream.send(JSON.stringify(d.msg));
  }

  async #connectUpstream(): Promise<void> {
    const token = await this.#viewer.accessToken();
    const ws = new WebSocket(wsUrl(this.#haUrl));
    this.#upstream = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', function first(raw) {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (m.type === 'auth_ok') { ws.off('message', first); resolve(); }
        else if (m.type === 'auth_invalid') reject(new Error('Core refused the viewer token'));
      });
    });
    ws.on('message', (raw) => this.#fromCore(raw.toString()));
    ws.on('close', () => this.#visitor.close());
    ws.on('error', () => this.#visitor.close());
  }

  #fromCore(text: string): void {
    // Runs on the same queue so it sees the same allowlist snapshot ordering as requests.
    this.#queue = this.#queue.then(async () => {
      const m: Msg = JSON.parse(text);
      const type = this.#types.get(m.id) ?? '';
      let out: Msg | null;
      try {
        out = outbound(type, m, await this.#published.get(), ctxFor(this.#pub));
      } catch (e) {
        log.warn(`dropped a reply to ${type}: ${(e as Error).message}`);
        out = null;
      }
      if (out) this.#send(out);
    }).catch(() => undefined);
  }
}
