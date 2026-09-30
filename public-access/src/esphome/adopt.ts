import type { Config } from '../config.ts';
import { coreRest } from '../core/admin.ts';

export interface AdoptResult { ok: boolean; message: string }

/**
 * Adds this add-on to Home Assistant as an ESPHome device by running Core's own ESPHome setup flow, the same
 * steps as Settings > Devices & services > Add integration > ESPHome. `host` is how Core reaches this
 * add-on (its Docker host name).
 */
export async function adoptIntoHomeAssistant(config: Config, host: string, port: number, noiseKey: string): Promise<AdoptResult> {
  const start = await coreRest(config, 'POST', '/config/config_entries/flow', { handler: 'esphome', show_advanced_options: false });
  if (start.status !== 200) return { ok: false, message: `Home Assistant would not start the ESPHome setup (${start.status}). Is the ESPHome integration available?` };
  let step = start.body;
  let data: Record<string, unknown> = { host, port };
  for (let i = 0; i < 5; i++) {
    if (step.type === 'create_entry') return { ok: true, message: `Added "${step.title ?? 'Public Access'}" to Home Assistant.` };
    if (step.type === 'abort') {
      return step.reason === 'already_configured'
        ? { ok: true, message: 'Home Assistant already has this device.' }
        : { ok: false, message: `Home Assistant stopped the setup: ${step.reason}` };
    }
    if (step.type !== 'form') return { ok: false, message: `Unexpected setup step: ${step.type}` };
    if (step.errors && Object.keys(step.errors).length) {
      return { ok: false, message: `Home Assistant could not use the device: ${Object.values(step.errors).join(', ')}. Check that it can reach ${host}:${port}.` };
    }
    if (step.step_id === 'encryption_key') data = { noise_psk: noiseKey };
    else if (step.step_id === 'user') data = { host, port };
    else return { ok: false, message: `Home Assistant asked for something unexpected (${step.step_id}). Add the device by hand with the key shown here.` };
    const next = await coreRest(config, 'POST', `/config/config_entries/flow/${step.flow_id}`, data);
    if (next.status !== 200) return { ok: false, message: `Home Assistant refused the setup (${next.status}).` };
    step = next.body;
  }
  return { ok: false, message: 'The setup did not finish. Add the device by hand with the key shown here.' };
}
