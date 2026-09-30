// Dev entry point for docker compose: wait for Core, seed it, then start the real app.
import { seed } from './seed.ts';

for (let i = 0; ; i++) {
  try { if ((await fetch(`${process.env.HA_URL}/manifest.json`)).ok) break; } catch { /* starting */ }
  if (i % 10 === 0) console.log('Waiting for Home Assistant...');
  await new Promise((r) => setTimeout(r, 3000));
}
await seed();
await import('../src/main.ts');
