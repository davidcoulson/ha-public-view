# M0 spike: Public Access add-on feasibility

Throwaway code that answers the M0 questions from the plan. It is not the add-on.

## Run on your Mac (Docker Desktop)

```sh
docker compose up --build
```

- Home Assistant starts with the `demo:` integration (fake lights, sensors, climate).
- The `spike` container (`node:26-alpine`) waits for HA, onboards an `admin` / `admin-m0-password` owner, runs the checks, prints them, then starts the public relay.
- Open **http://localhost:8099/lovelace/0**. That is the real HA frontend, loaded with a placeholder token, talking to the relay, not to HA.
- `http://localhost:8099/m0/results` shows the check results and which websocket types the frontend asked for.
- Hostile-visitor test (relay must refuse every write): `docker compose exec spike node test/relay-smoke.mjs`
- Reset everything: `docker compose down` then delete `ha-config/.storage` and the other generated files in `ha-config/` (keep `configuration.yaml`).

Not run in Docker yet: the sandbox that built this has no Docker daemon. I tested the same code with a native
Home Assistant 2026.2.3 (Python 3.13) and Node 22 in Linux x86_64. The `node:26-alpine` tag, the `stable` HA image and Apple silicon are untested.

## Results (native HA 2026.2.3, Node 22)

| Check | Result |
| --- | --- |
| C1 `config/auth/create` accepts `system-read-only` for a normal user | **Pass** |
| C2 password credential can be added | **Pass** |
| C3 add-on logs in as the viewer, gets a refresh token | **Pass** |
| C4a viewer reads states | **Pass** (109 states) |
| C4b viewer refused `light.turn_on` | **Pass** |
| C4c viewer refused `persistent_notification.create` (no entity target) | **Fails: the call is accepted** |
| C4d viewer cannot list users | **Pass** |
| C5 control: a plain non-admin user can call services | Confirmed |
| C6 `home-assistant-js-websocket` on Node with `ws` | **Pass**, once the socket factory receives `options` not `auth` |
| Real frontend boots with a placeholder token via the relay | **Pass** (screenshot: `frontend-through-relay.png`) |
| Relay refuses every write in `test/relay-smoke.mjs` | **Pass** (9/9), incl. `persistent_notification.create` |

### What this changes in the plan

1. **Read-only group works for a normal user**, so no companion custom component is needed.
2. **But it is only a partial second lock.** It blocks entity-targeted services, not ones with no entity, so a viewer
   could create persistent notifications. The relay allowlist has to be treated as the primary barrier.
   `call_service` is refused by message type and never forwarded.
3. **The viewer sees the home's location.** `get_config` returned latitude, longitude and `config_dir`. The relay
   already redacts these. `config/device_registry/list` (50 devices), `manifest/list` and `get_services` also
   answer for the viewer and are not filtered yet.
4. **An own-origin add-on is simpler than the integration.** Serving `/api/websocket` directly means the browser needs
   no websocket steering, only a `localStorage` token seed (`spike/src/bootstrap.js`).
5. **The allowlist can be discovered, not copied.** `/m0/results` lists what the frontend asked for and what was refused.

### Still open after M0

- Header and sidebar are visible; kiosk mode is M2 work.
- `get_panels` shows every panel; must be rewritten to one (M3).
- `render_template` (the "Welcome {{ user }}" card), `energy/get_prefs`, `usage_prediction/common_control`
  are refused, so some cards show errors. `system_log.write` from the frontend should be answered quietly.
- `/sw-modern.js` is a 404 (the frontend logs a service-worker error). Harmless here, needs a decision.
- No history REST twin, no session or rate limits, no Cloudflare header handling.
- The viewer password is a fixed string in `checks.mjs` and the viewer can log in only as `local_only`. Real
  provisioning generates a random password.
- Nothing here has been tried with a custom HACS card, a camera or the energy dashboard.
