import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Publication } from './config.ts';

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export class ValidationError extends Error {}

/** Returns a clean copy or throws ValidationError with a message the owner can act on. */
export function validatePublications(input: unknown): Publication[] {
  if (!Array.isArray(input)) throw new ValidationError('Publications must be a list');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const label = `Publication ${i + 1}`;
    const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
    const hostname = str('hostname').toLowerCase();
    if (!HOSTNAME.test(hostname)) throw new ValidationError(`${label}: "${hostname}" is not a valid host name`);
    if (seen.has(hostname)) throw new ValidationError(`${label}: host name ${hostname} is used twice`);
    seen.add(hostname);
    const dashboard = str('dashboard');
    const view = p.view === undefined ? '' : String(p.view).trim();
    if (!dashboard) throw new ValidationError(`${label}: choose a dashboard`);
    if (!view) throw new ValidationError(`${label}: choose a view`);
    const title = str('title');
    if (title.length > 80) throw new ValidationError(`${label}: the title is longer than 80 characters`);
    return { hostname, dashboard, view, title: title || undefined, noindex: p.noindex === false ? false : true, enabled: p.enabled === false ? false : true };
  });
}

/** The live list of publications. Changes apply to the next request; no restart. */
export class PublicationStore {
  #list: Publication[];
  #file: string;
  #listeners: Array<() => void> = [];

  private constructor(list: Publication[], file: string) { this.#list = list; this.#file = file; }

  /** The saved list wins; the add-on options only seed a fresh install. */
  static async load(dataDir: string, seed: Publication[]): Promise<PublicationStore> {
    const file = join(dataDir, 'publications.json');
    try {
      return new PublicationStore(validatePublications(JSON.parse(await readFile(file, 'utf8'))), file);
    } catch {
      return new PublicationStore(seed, file);
    }
  }

  list(): Publication[] { return this.#list; }
  onChange(fn: () => void): void { this.#listeners.push(fn); }

  async set(input: unknown): Promise<Publication[]> {
    const next = validatePublications(input);
    await mkdir(join(this.#file, '..'), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, this.#file);
    this.#list = next;
    this.#listeners.forEach((fn) => fn());
    return next;
  }
}
