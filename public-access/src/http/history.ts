import type { Published } from '../policy/published.ts';

const MAX_SPAN_MS = 31 * 86_400_000;

/**
 * Some cards (ApexCharts) read history over REST instead of the websocket. Same path and answer as
 * Core's /api/history/period, but only the published entities are ever returned.
 */
export async function historyPeriod(
  haUrl: string, token: string, pub: Published, path: string, query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const startText = path.replace(/^\/api\/history\/period\/?/, '');
  const start = startText ? Date.parse(decodeURIComponent(startText)) : Date.now() - 86_400_000;
  const endText = query.get('end_time');
  const end = endText ? Date.parse(endText) : start + 86_400_000;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start || end - start > MAX_SPAN_MS) {
    return { status: 400, body: { message: 'Invalid time range' } };
  }
  const wanted = (query.get('filter_entity_id') ?? '').toLowerCase().split(',').filter(Boolean);
  if (!wanted.length) return { status: 400, body: { message: 'filter_entity_id is missing' } };
  const ids = wanted.filter((e) => pub.entities.has(e));
  if (!ids.length) return { status: 200, body: [] };

  const params = new URLSearchParams({ filter_entity_id: ids.join(','), end_time: new Date(end).toISOString() });
  for (const flag of ['minimal_response', 'no_attributes', 'significant_changes_only', 'skip_initial_state']) {
    if (query.has(flag)) params.set(flag, '');
  }
  const r = await fetch(`${haUrl}/api/history/period/${encodeURIComponent(new Date(start).toISOString())}?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: r.ok ? await r.json() : { message: 'Upstream error' } };
}
