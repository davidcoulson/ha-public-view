// Drives a real browser against the public page. Needs the app running (default :8099), Core seeded by
// dev/seed.ts, and Chromium (set CHROMIUM_PATH, or install one with `npx playwright-core install chromium`).
import { chromium } from 'playwright-core';
import { HaSocket, login, wsUrl } from '../../src/core/client.ts';

const BASE = process.env.RELAY_URL ?? 'http://localhost:8099';
const HA_URL = process.env.HA_URL ?? 'http://localhost:8123';
const results: Array<{ name: string; ok: boolean; got: string }> = [];
const check = (name: string, ok: boolean, got: unknown = '') => results.push({ name, ok, got: String(got) });

async function coreState(entityId: string): Promise<string> {
  const tokens = await login(HA_URL, process.env.PA_ADMIN_USER ?? 'admin', process.env.PA_ADMIN_PASS ?? 'admin-dev-password');
  const ws = await HaSocket.connect(wsUrl(HA_URL), tokens.access_token);
  try { return (await ws.call<Array<{ entity_id: string; state: string }>>('get_states')).find((s) => s.entity_id === entityId)!.state; }
  finally { ws.close(); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const failedRequests: string[] = [];
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });

  await page.goto(`${BASE}/`);
  await page.getByText('Outside Temperature').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  check('opens on the published view', new URL(page.url()).pathname === '/lovelace/solar', new URL(page.url()).pathname);
  check('shows the published cards', await page.getByText('Outside Humidity').first().isVisible());
  check('does not show anything from the private view', (await page.getByText('Front Door').count()) === 0 && (await page.getByText('Secrets').count()) === 0);
  check('tab title is the publication title', (await page.title()).startsWith('Solar demo'), await page.title());

  const chrome = await page.evaluate(() => {
    const out = { headerHidden: true, sidebarWidth: 0, menuButtonHidden: true };
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.classList.contains('header') || el.classList.contains('toolbar')) if (getComputedStyle(el).display !== 'none') out.headerHidden = false;
        if (el.localName === 'ha-menu-button' && getComputedStyle(el).display !== 'none') out.menuButtonHidden = false;
        if (el.localName === 'ha-sidebar') out.sidebarWidth = Math.max(out.sidebarWidth, el.getBoundingClientRect().width);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  });
  check('kiosk: header and toolbar hidden', chrome.headerHidden && chrome.menuButtonHidden, JSON.stringify(chrome));
  check('kiosk: sidebar takes no space', chrome.sidebarWidth === 0, chrome.sidebarWidth);

  const before = await coreState('light.bed_light');
  await page.getByText('Bed Light').first().click({ force: true });
  await page.waitForTimeout(1500);
  check('clicking a light changes nothing in Core', (await coreState('light.bed_light')) === before, before);

  const interesting = failedRequests.filter((r) => !r.includes('/api/error_log'));
  check('no failed HTTP requests while loading', interesting.length === 0, interesting.join(', '));

  const other = await browser.newPage();
  await other.goto(`${BASE}/config/dashboard`);
  await other.waitForTimeout(4000);
  check('an admin URL (/config/dashboard) lands on the published view instead', new URL(other.url()).pathname === '/lovelace/solar', new URL(other.url()).pathname);
} finally {
  await browser.close();
}

for (const r of results) console.log(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.name}${r.ok ? '' : `\n        got: ${r.got}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
