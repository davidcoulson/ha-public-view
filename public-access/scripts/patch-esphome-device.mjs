// esphome-device 0.2.0 closes the socket when a plaintext client reaches a device that requires Noise
// encryption. Home Assistant's "Add integration > ESPHome" flow (and aioesphomeapi) expect the explicit
// "Bad indicator byte" reject frame instead, which is how they learn that an encryption key is needed;
// without it the flow reports a connection error. This applies the fix until a release carries it.
// Safe to run repeatedly; does nothing once the library is fixed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../node_modules/esphome-device/src/device.mjs', import.meta.url));
if (!existsSync(file)) process.exit(0);

const src = readFileSync(file, 'utf8');
if (src.includes("rejectFrame('Bad indicator byte')")) process.exit(0); // already fixed

const before = "this.device._log('warn', `${this.peer}: client sent plaintext but a noise key is required`); return this.close(); }";
const after = "this.device._log('warn', `${this.peer}: client sent plaintext but a noise key is required`); try { this.socket.write(new NoiseFramer({ psk: this.device.psk, name: this.device.name, mac: this.device.mac.plain }).rejectFrame('Bad indicator byte')); } catch {} return this.close(); }";
if (!src.includes(before)) {
  console.warn('patch-esphome-device: the library changed and the fix could not be applied; adding the device to Home Assistant may fail with a connection error.');
  process.exit(0);
}
writeFileSync(file, src.replace(before, after));
console.log('patch-esphome-device: applied the plaintext-reject fix');
