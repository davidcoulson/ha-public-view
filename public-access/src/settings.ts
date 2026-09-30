import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export interface SettingsData {
  /** Serve nobody: every public request answers 503 and live visitors are disconnected. */
  paused: boolean;
  maxSessions: number;
  maxSessionsPerVisitor: number;
  logLevel: LogLevelName;
}

const clampInt = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

/**
 * Values the owner can change at run time from Home Assistant (through the ESPHome device). What they set is
 * saved and wins over the add-on options until they change it again; everything else follows the options.
 */
export class Settings extends EventEmitter {
  #data: SettingsData;
  #overrides: Partial<SettingsData>;
  #file: string;

  private constructor(defaults: SettingsData, overrides: Partial<SettingsData>, file: string) {
    super();
    this.#overrides = overrides;
    this.#data = { ...defaults, ...overrides };
    this.#file = file;
  }

  static async load(dataDir: string, defaults: SettingsData): Promise<Settings> {
    const file = join(dataDir, 'settings.json');
    let overrides: Partial<SettingsData> = {};
    try { overrides = JSON.parse(await readFile(file, 'utf8')); } catch { /* first start */ }
    return new Settings(defaults, sanitize(overrides), file);
  }

  get data(): Readonly<SettingsData> { return this.#data; }

  async update(patch: Partial<SettingsData>): Promise<void> {
    const clean = sanitize(patch);
    if (!Object.keys(clean).length) return;
    this.#overrides = { ...this.#overrides, ...clean };
    this.#data = { ...this.#data, ...clean };
    await mkdir(join(this.#file, '..'), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#overrides, null, 2));
    await rename(tmp, this.#file);
    this.emit('change', this.#data);
  }
}

export function sanitize(p: Partial<SettingsData>): Partial<SettingsData> {
  const out: Partial<SettingsData> = {};
  if (typeof p.paused === 'boolean') out.paused = p.paused;
  const ms = clampInt(p.maxSessions, 1, 500); if (ms !== undefined) out.maxSessions = ms;
  const mp = clampInt(p.maxSessionsPerVisitor, 1, 50); if (mp !== undefined) out.maxSessionsPerVisitor = mp;
  if (p.logLevel && (LOG_LEVELS as readonly string[]).includes(p.logLevel)) out.logLevel = p.logLevel;
  return out;
}
