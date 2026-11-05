import type { AdServicesResult } from '@appdash/shared';

export type AdServicesOutcome = { status: 'ok'; result: AdServicesResult } | { status: 'retry' } | { status: 'invalid' };

const ENDPOINT = 'https://api-adservices.apple.com/api/v1/';
/** 404 means Apple has not produced the attribution yet: wait and try again, three attempts in total. */
const MAX_ATTEMPTS = 3;
const NOT_READY_WAIT_MS = 5000;
/** A hanging Apple call counts as `retry`, so the waitUntil work cannot outlive its window. */
const FETCH_TIMEOUT_MS = 5000;

const defaultSleep = (ms: number): Promise<void> =>
  typeof scheduler !== 'undefined' ? scheduler.wait(ms) : new Promise((resolve) => setTimeout(resolve, ms));

/** Exchange an AdServices token for its attribution. The token is never logged. */
export async function exchangeAdServicesToken(
  token: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  sleep: (ms: number) => Promise<void> = defaultSleep,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<AdServicesOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      return { status: 'retry' };
    }
    if (res.status === 200) {
      try {
        return { status: 'ok', result: (await res.json()) as AdServicesResult };
      } catch {
        return { status: 'retry' };
      }
    }
    if (res.status === 400) return { status: 'invalid' };
    if (res.status !== 404) return { status: 'retry' };
    if (attempt < maxAttempts) await sleep(NOT_READY_WAIT_MS);
  }
  return { status: 'retry' };
}
