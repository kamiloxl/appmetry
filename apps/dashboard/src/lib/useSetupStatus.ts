import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { SetupStatus } from './types';

export const POLL_MS = 3000;

/**
 * Load GET /api/apps/:id/setup. While `poll` is true it refreshes every 3 s, but only while the tab is visible:
 * the timer stops when the page is hidden (and refreshes at once when it comes back) and on unmount.
 */
export function useSetupStatus(appId: string | null, poll = false) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!appId) return;
    try {
      setStatus(await api<SetupStatus>(`/api/apps/${appId}/setup`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  }, [appId]);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!poll || !appId) return;
    let timer: number | undefined;
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      if (timer === undefined && document.visibilityState === 'visible') timer = window.setInterval(() => void refresh(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else stop();
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll, appId, refresh]);

  return { status, setStatus, error, refresh };
}
