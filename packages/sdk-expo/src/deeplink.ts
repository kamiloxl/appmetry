import * as Linking from 'expo-linking';

import { log } from './log';

export interface LinkingLike {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: 'url', cb: (e: { url: string }) => void): { remove(): void };
}

/** The initial URL is read once per process, even if the SDK is deactivated and activated again. */
let initialUrlRead = false;

/** Test seam: forgets that the initial URL was read. */
export function resetDeepLinksForTests(): void {
  initialUrlRead = false;
}

/**
 * Reports the URL the app was opened with (once per process) and every URL received while running.
 * Returns a function that unsubscribes and drops anything still in flight.
 */
export function startDeepLinks(onLink: (url: string) => void, linking: LinkingLike = Linking as unknown as LinkingLike): () => void {
  let stopped = false;
  const deliver = (url: unknown) => {
    if (stopped || typeof url !== 'string' || url === '') return;
    try {
      onLink(url);
    } catch (err) {
      log('deep link handler failed', err);
    }
  };

  let sub: { remove(): void } | null = null;
  try {
    sub = linking.addEventListener('url', (e) => deliver(e?.url));
  } catch (err) {
    log('Linking.addEventListener failed', err);
  }

  if (!initialUrlRead) {
    initialUrlRead = true;
    Promise.resolve()
      .then(() => linking.getInitialURL())
      .then(deliver)
      .catch((err: unknown) => log('Linking.getInitialURL failed', err));
  }

  return () => {
    stopped = true;
    try {
      sub?.remove();
    } catch {
      // ignore
    }
    sub = null;
  };
}
