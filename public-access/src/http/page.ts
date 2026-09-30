import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Publication } from '../config.ts';

const bootstrapTemplate = readFileSync(fileURLToPath(new URL('../client/bootstrap.js', import.meta.url)), 'utf8');

// Applied inside the frontend's shadow roots. Only the chrome is hidden; the dashboard itself is untouched.
const KIOSK_CSS = `
.header, .toolbar, ha-menu-button, .mdc-top-app-bar { display: none !important; }
:host { --header-height: 0px !important; }
#view, .view { min-height: 100vh !important; padding-top: 0 !important; }
.edit-mode { display: none !important; }
`;

export function bootstrapScript(): string {
  return bootstrapTemplate.replace('__PA_CONFIG__', JSON.stringify({ kiosk: true, css: KIOSK_CSS }));
}

/** Core's own index page with the bootstrap in front of everything else. */
export function renderIndex(coreHtml: string, pub: Publication): string {
  let html = coreHtml.replace(/<head[^>]*>/i, (m) => `${m}<script>${bootstrapScript()}</script>`);
  if (pub.title) html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(pub.title)}</title>`);
  return html;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// The frontend registers a service worker. On our own origin it would only cache Core's pages, so
// serve one that removes itself (and any left behind by an earlier version).
export const SELF_REMOVING_SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  self.registration.unregister().then(() => self.clients.matchAll()).then((cs) => cs.forEach((c) => c.navigate(c.url)))
));
`;
