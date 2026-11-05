import { useState } from 'react';
import { api } from './api';
import type { RcSecret } from './types';

/** Generate (or rotate) an app's RevenueCat webhook secret. The secret is kept in memory only: the server shows it once. */
export function useRcSecret(appId: string, onGenerated: () => void) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RcSecret>(`/api/apps/${appId}/rc-secret`, { method: 'POST' });
      setSecret(r.secret);
      onGenerated();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { secret, setSecret, busy, error, generate };
}
