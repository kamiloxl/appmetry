let debug = false;

/** Turns SDK debug logging on or off. Wired to `Appmetry.init({ debug })`. */
export function setDebug(on: boolean): void {
  debug = on === true;
}

/** Internal logger: a no-op unless debug is on. Never throws. */
export function log(...args: unknown[]): void {
  if (!debug) return;
  try {
    console.log('[appmetry]', ...args);
  } catch {
    // console unavailable: ignore
  }
}
