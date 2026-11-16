import type { ActiveIntegration, IntegrationConfig, Mapping, SendScope } from './types';

const CACHE_MS = 60_000;
const cache = new Map<string, { list: ActiveIntegration[]; at: number }>();

function parseConfig(json: string | null): IntegrationConfig {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as IntegrationConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Active integrations of an app with their mappings. Ingestion asks for every batch, so the result (also an empty
 * one) is cached per isolate for 60 s, like apps in env.ts. Call `forgetIntegrations` after a settings change.
 */
export async function activeIntegrations(db: D1Database, appId: string): Promise<ActiveIntegration[]> {
  const hit = cache.get(appId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;

  const { results } = await db
    .prepare(
      `SELECT i.id, i.app_id, i.provider, i.send_scope, i.config,
              m.source_event, m.target_event, m.send_value, m.locked
       FROM integrations i LEFT JOIN integration_mappings m ON m.integration_id = i.id AND m.app_id = i.app_id
       WHERE i.app_id = ? AND i.status = 'active'
       ORDER BY i.id`,
    )
    .bind(appId)
    .all<{
      id: string; app_id: string; provider: string; send_scope: string; config: string | null;
      source_event: string | null; target_event: string | null; send_value: number | null; locked: number | null;
    }>();

  const byId = new Map<string, ActiveIntegration>();
  for (const r of results) {
    let it = byId.get(r.id);
    if (!it) {
      it = {
        id: r.id,
        app_id: r.app_id,
        provider: r.provider,
        send_scope: (r.send_scope === 'attributed' ? 'attributed' : 'all') as SendScope,
        config: parseConfig(r.config),
        mappings: new Map<string, Mapping>(),
      };
      byId.set(r.id, it);
    }
    if (r.source_event && r.target_event) {
      it.mappings.set(r.source_event, {
        source_event: r.source_event,
        target_event: r.target_event,
        send_value: r.send_value === 1,
        locked: r.locked === 1,
      });
    }
  }
  const list = [...byId.values()];
  cache.set(appId, { list, at: Date.now() });
  return list;
}

/** Drop an app's integrations from this isolate's cache after they change. */
export function forgetIntegrations(appId: string): void {
  cache.delete(appId);
}
