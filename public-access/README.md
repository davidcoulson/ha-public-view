# Public Access (add-on)

A Home Assistant add-on that publishes **one view of one dashboard**, read-only, with no login. Written from
scratch (TypeScript on Node, no code from the `dllfpp/ha-public-access` integration).

```
visitor ─▶ Cloudflare ─▶ Cloudflared add-on ─▶ this app ──(websocket as a read-only viewer user)──▶ Home Assistant Core
```

## What is built

| Milestone | What | Where |
| --- | --- | --- |
| M1 | Viewer user created through Core's API (`system-read-only`, `local_only`, random password, refresh-token handling, login back-off). Websocket relay that rebuilds every allowed message from named fields and answers the rest locally. | `src/core/`, `src/relay/`, `src/policy/filter.ts` |
| M2 | Serves Core's real frontend on its own origin: page with a placeholder-login bootstrap, kiosk mode (no sidebar, no header), static-file proxy with an allowlist and an in-memory cache, self-removing service worker, history REST twin, `robots.txt`, `/healthz`. | `src/http/`, `src/client/bootstrap.js` |
| M3 | Isolation to the chosen view: entity, statistic and template allowlists scanned from the view; one panel; one view; device, area, floor, label registries filtered; `get_config` location hidden; device identifiers and MAC addresses removed. | `src/policy/scan.ts`, `published.ts`, `filter.ts` |

| M4 | Visitor address from `CF-Connecting-IP` (trusted only from private peers), page and static rate limits, caps on live visitors (total and per address), flood cut-off, heartbeat that drops dead connections. | `src/http/guard.ts` |
| M5 | Setup panel through Home Assistant ingress: pick dashboard and view, preview exactly what visitors can read, edit publications live (no restart), copy the Cloudflared snippet. Only the Supervisor may reach it. | `src/ui/`, `src/publications.ts` |
| M6 | Add-on packaging (`config.yaml`, `build.yaml`, `Dockerfile` on `node:26-alpine`, docs, translations, icon), repository file, GitHub Actions. | `config.yaml`, `DOCS.md`, `../repository.yaml`, `../.github/workflows/public-access.yml` |

| ESPHome | Shows up in Home Assistant as a device (via the `esphome-device` library): sensors, pause switch, live limits, per-address switches, buttons; one-click adoption through Core's own ESPHome setup flow. | `src/esphome/`, `src/settings.ts` |

Not built yet: a browser test matrix across Home Assistant releases, a one-click Cloudflare setup, a shared upstream
connection for many visitors, a release pipeline that publishes images.

## Install it as an add-on

Add `https://github.com/davidcoulson/ha-public-view` under **Settings > Add-ons > Add-on store > ⋮ > Repositories**.
Public Access then appears in the store; the Supervisor builds the image on your Home Assistant host (no registry
involved). Open the **Public Access** panel, add a publication, and paste the snippet it shows into the Cloudflared
add-on. Full instructions: `DOCS.md`.

This has **not** been run on a real Supervisor yet. The manifest was checked as YAML only.

## Run it

Local stack, no Docker needed if you have Home Assistant elsewhere: set `HA_URL`, `PA_ADMIN_USER`, `PA_ADMIN_PASS`
(used once to create the viewer; inside a real add-on the Supervisor token is used instead), `PA_OPTIONS_FILE`
(see `dev/options.json`), and `DATA_DIR`, then `npm start`.

With Docker (node:26-alpine):

```sh
cd dev && docker compose up --build      # then http://localhost:8099/
```

## Tests

```sh
npm install
npm run check        # type check
npm test             # 53 unit tests: filter rules, view scanning, limits, visitor address, publications, ESPHome entities
node dev/seed.ts && npm run e2e     # 31 websocket/REST checks + 9 browser checks against a live Core (app must be running)
npm run e2e:esphome                  # 14 checks driving the app from Home Assistant (after "Add to Home Assistant" in the panel)
```

The e2e suite was mutation-checked: removing the `get_states` filter or the template check makes it fail.

## Decisions worth knowing

- **Allowlist first.** The read-only group does not stop services that target no entity (M0 finding), so
  `call_service` is never forwarded. Inbound messages are rebuilt from named fields; unknown fields are dropped.
- **Empty allowlist never reaches Core.** An empty `entity_ids` list means "everything" to Core.
- **Owner's text only.** `render_template` is accepted only for strings that appear verbatim in the published view.
- **Fails closed.** If the view is missing or Core cannot be read, nothing is published. A reply that cannot be
  filtered is dropped.
- **Frontend quirks found by running it:** without `localStorage.defaultPanel` the frontend falls back to a "home"
  panel that is not in the list and renders nothing; the panel key is `lovelace` so `/` needs no redirect.

## Known gaps

- Strategy-based dashboards (no explicit cards) cannot be scanned, so they publish no entities.
- Custom cards that pick entities dynamically (for example auto-entities) only see entities named in the view.
- Clicking an entity opens the more-info dialog; its `config/entity_registry/get` call is refused, which shows as a
  console error. Controls inside it cannot do anything.
- Energy dashboard: preferences and their statistics are allowed; `energy/validate`, `energy/solar_forecast` and
  `energy/fossil_energy_consumption` are refused, so some energy cards will be incomplete.
- Not yet run in Docker, on a real Supervisor, or against Home Assistant 2026.9 (tested natively on 2026.2.3, Node 22).
  The GitHub Actions workflow has not run either.
- The Supervisor-side paths (`ws://supervisor/core/websocket`, `/addons/self/info`) are written from documentation, untested.
- `esphome-device` 0.2.0 closes the connection on a plaintext probe instead of replying "requires encryption", so
  Home Assistant's setup flow fails. `scripts/patch-esphome-device.mjs` applies the fix after `npm install` until a
  release carries it (`docs/esphome-device-plaintext-reject.patch` is the same change as a patch).
- The device's entity list is fixed per start, so adding or removing an address restarts it for a few seconds.
- mDNS is off (multicast does not leave the add-on's network), so the device is added by host name, not discovered.
- One instance per Home Assistant: starting a second deletes and recreates the shared "Public Access viewer" user.
- The viewer's refresh token and password live in `/data/viewer.json` (mode 600). They are included in add-on backups.
