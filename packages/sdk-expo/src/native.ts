/**
 * Hook for install-time attribution data (Play Install Referrer, Apple Search Ads token).
 * Returns nothing until the native module is wired in (Task 17).
 */
export async function collectInstallProps(): Promise<Record<string, unknown>> {
  return {};
}
