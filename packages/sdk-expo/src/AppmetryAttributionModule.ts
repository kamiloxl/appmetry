import { NativeModule, requireOptionalNativeModule } from 'expo';

export type InstallReferrerResult = {
  referrer: string;
  /** Seconds since epoch. */
  clickTs: number;
  /** Seconds since epoch. */
  installTs: number;
};

// Native install-attribution module. Each method exists on one platform only,
// so both are optional and callers must guard.
// `null` when the native module is not linked (Expo Go, web, tests).
declare class AppmetryAttributionModule extends NativeModule<{}> {
  /** iOS 14.3+: AdServices attribution token, or null when unavailable. */
  getAdServicesToken?: () => Promise<string | null>;
  /** Android: Play Install Referrer data, or null when unavailable. */
  getInstallReferrer?: () => Promise<InstallReferrerResult | null>;
  /** iOS 14+: the current ATT status. Never shows the prompt. */
  getTrackingAuthorizationStatus?: () => Promise<'authorized' | 'denied' | 'restricted' | 'notDetermined' | null>;
  /**
   * IDFA (iOS, only when ATT is authorized) or GAID (Android, only when the user has not limited ad tracking),
   * or null. The SDK calls this only with ad consent.
   */
  getAdvertisingId?: () => Promise<string | null>;
}

export default requireOptionalNativeModule<AppmetryAttributionModule>('AppmetryAttribution');
