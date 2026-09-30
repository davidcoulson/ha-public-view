import type { Config } from './config.ts';
import type { Viewer } from './core/viewer.ts';

export interface Health { core: boolean; message: string }

/** Checks every 30 s that Core answers and the viewer can still sign in. */
export function startHealthProbe(config: Config, viewer: Viewer): { get(): Health; probe(): Promise<void>; stop(): void } {
  let state: Health = { core: false, message: 'starting' };
  const probe = async () => {
    try {
      const r = await fetch(`${config.haUrl}/manifest.json`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`Core answered ${r.status}`);
      await viewer.accessToken();
      state = { core: true, message: 'ok' };
    } catch (e) {
      state = { core: false, message: (e as Error).message.slice(0, 120) };
    }
  };
  const timer = setInterval(probe, 30_000);
  timer.unref();
  return { get: () => state, probe, stop: () => clearInterval(timer) };
}
