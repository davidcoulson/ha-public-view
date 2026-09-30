/** Fetches Core's public static files (frontend bundle, icons, custom cards) and keeps small ones in memory. */

// Everything else is a 404 here, so a visitor cannot reach /api/* or /auth/* on Core through this server.
export const STATIC_PREFIXES = ['/frontend_latest/', '/static/', '/hacsfiles/', '/local/', '/manifest.json'];

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const TTL_MS = 10 * 60_000;
const PASS = ['content-type', 'cache-control', 'etag', 'last-modified'];

export interface Asset { status: number; headers: Record<string, string>; body: Buffer }

export function isStaticPath(path: string): boolean {
  return STATIC_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p)) && !path.includes('..');
}

export class AssetCache {
  #haUrl: string;
  #map = new Map<string, { at: number; asset: Asset }>();
  #bytes = 0;

  constructor(haUrl: string) { this.#haUrl = haUrl; }

  async get(pathAndQuery: string): Promise<Asset> {
    const hit = this.#map.get(pathAndQuery);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.asset;
    const r = await fetch(`${this.#haUrl}${pathAndQuery}`, { redirect: 'manual' });
    const headers: Record<string, string> = {};
    for (const h of PASS) { const v = r.headers.get(h); if (v) headers[h] = v; }
    const asset: Asset = { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) };
    if (r.ok && asset.body.length <= MAX_ENTRY_BYTES) this.#store(pathAndQuery, asset);
    return asset;
  }

  #store(key: string, asset: Asset): void {
    this.#bytes += asset.body.length;
    this.#map.set(key, { at: Date.now(), asset });
    // Oldest first: Map keeps insertion order.
    for (const [k, v] of this.#map) {
      if (this.#bytes <= MAX_TOTAL_BYTES) break;
      this.#bytes -= v.asset.body.length;
      this.#map.delete(k);
    }
  }
}
