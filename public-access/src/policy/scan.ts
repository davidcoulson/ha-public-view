/** Reads a dashboard view and lists what it refers to. Pure; no I/O. */

export interface ViewScan {
  /** Entity ids found anywhere in the view, including inside templates and JS snippets. */
  entities: Set<string>;
  /** External statistic ids such as "sensor:energy". */
  statistics: Set<string>;
  /** Strings that are rendered as templates, verbatim. render_template is allowed only for these. */
  templates: Set<string>;
  /** Every string value, for matching area, floor, label and device ids. */
  strings: Set<string>;
  /** The view uses energy cards, so the energy preferences may be read. */
  energy: boolean;
}

// An id may sit inside a longer string (a template, or a button-card JS expression).
const ENTITY_IN_TEXT = /(?<![\w.])([a-z_]+\.[a-z0-9_]+)(?![\w.]*\w)/g;
const STATISTIC_IN_TEXT = /(?<![\w.:])([a-z0-9_]+:[a-z0-9_]+)(?![\w:])/g;
const TEMPLATE_MARK = /\{\{|\{%|\{#/;

export function scanView(view: unknown): ViewScan {
  const out: ViewScan = { entities: new Set(), statistics: new Set(), templates: new Set(), strings: new Set(), energy: false };
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.strings.add(value);
      for (const m of value.matchAll(ENTITY_IN_TEXT)) out.entities.add(m[1]);
      for (const m of value.matchAll(STATISTIC_IN_TEXT)) out.statistics.add(m[1]);
      if (TEMPLATE_MARK.test(value)) out.templates.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.type === 'string' && obj.type.startsWith('energy-')) out.energy = true;
      Object.values(obj).forEach(walk);
    }
  };
  walk(view);
  return out;
}

export interface LovelaceView { path?: string | number; [key: string]: unknown }

/** The one view the owner chose. null when it is gone: publish nothing rather than another view. */
export function pickView(config: unknown, viewPath: string): LovelaceView | null {
  const views = (config as { views?: unknown } | null)?.views;
  if (!Array.isArray(views)) return null;
  for (const v of views) {
    if (v && typeof v === 'object' && (v as LovelaceView).path !== undefined && String((v as LovelaceView).path) === String(viewPath)) {
      return v as LovelaceView;
    }
  }
  return null;
}
