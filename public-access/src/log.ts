const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof order;
let threshold: number = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 1;

export function setLogLevel(level: string | undefined): void {
  if (level && level in order) threshold = order[level as Level];
}

function write(level: Level, message: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};
