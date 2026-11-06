import type { PostbackAdapter } from './types';

/** Adapters by provider. Each network registers itself here (Meta in a later change; tests register fakes). */
const adapters = new Map<string, PostbackAdapter>();

export function registerAdapter(adapter: PostbackAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getAdapter(provider: string): PostbackAdapter | null {
  return adapters.get(provider) ?? null;
}
