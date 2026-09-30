import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

function isPrivate(addr: string): boolean {
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  const l = a.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

function validIp(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s && isIP(s) ? s : undefined;
}

/**
 * Who is this visitor, for limits. The app is only reachable through the Cloudflared add-on on the internal
 * Docker network, so a private peer is a proxy and the address it reports can be trusted. A public peer
 * connected directly; headers it sends are ignored, because anyone can forge them.
 *
 * This only feeds rate limits. It is not an access decision.
 */
export function visitorAddress(remote: string | undefined, headers: IncomingHttpHeaders): string {
  if (!remote) return 'unknown';
  if (!isPrivate(remote)) return remote;
  const cf = validIp(headers['cf-connecting-ip']);
  if (cf) return cf;
  const forwarded = String(headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // The last entry is the one our own proxy appended; earlier ones are whatever the client claimed.
  const last = forwarded.at(-1);
  return last && isIP(last) ? last : remote;
}

/** Fixed one-minute windows per key. Small and bounded; good enough for a public page. */
export class RateLimiter {
  #limit: number;
  #hits = new Map<string, { window: number; count: number }>();
  #now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) { this.#limit = perMinute; this.#now = now; }

  allow(key: string): boolean {
    const window = Math.floor(this.#now() / 60_000);
    const e = this.#hits.get(key);
    const count = e && e.window === window ? e.count + 1 : 1;
    this.#hits.set(key, { window, count });
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.window !== window) this.#hits.delete(k);
    return count <= this.#limit;
  }
}

/** Caps live websockets overall and per visitor. Each one holds a connection open to Core. */
export class SessionLimiter {
  #total: number;
  #perVisitor: number;
  #by = new Map<string, number>();
  #count = 0;

  constructor(total: number, perVisitor: number) { this.#total = total; this.#perVisitor = perVisitor; }

  get active(): number { return this.#count; }

  /** Returns a release function, or null when a cap is reached. */
  acquire(key: string): (() => void) | null {
    const mine = this.#by.get(key) ?? 0;
    if (this.#count >= this.#total || mine >= this.#perVisitor) return null;
    this.#by.set(key, mine + 1);
    this.#count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#count--;
      const n = (this.#by.get(key) ?? 1) - 1;
      if (n <= 0) this.#by.delete(key); else this.#by.set(key, n);
    };
  }
}

/** Counts events in a sliding window; used to cut off a connection that floods messages. */
export class Flood {
  #limit: number;
  #windowMs: number;
  #times: number[] = [];
  #now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) { this.#limit = limit; this.#windowMs = windowMs; this.#now = now; }
  /** True while within the limit. */
  hit(): boolean {
    const t = this.#now();
    this.#times.push(t);
    while (this.#times.length && this.#times[0] <= t - this.#windowMs) this.#times.shift();
    return this.#times.length <= this.#limit;
  }
}
