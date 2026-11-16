import { meta } from './meta';
import type { PostbackAdapter } from './types';

/** Adapters by provider. Tests register fakes next to the real ones. */
const adapters = new Map<string, PostbackAdapter>([[meta.provider, meta]]);

/** Networks the dashboard offers, in display order. */
export const PROVIDERS: ReadonlyArray<{ provider: string; name: string }> = [{ provider: 'meta', name: 'Meta Ads' }];

export function registerAdapter(adapter: PostbackAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getAdapter(provider: string): PostbackAdapter | null {
  return adapters.get(provider) ?? null;
}
