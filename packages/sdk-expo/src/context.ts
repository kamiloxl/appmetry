import type { BatchContext, Platform as SdkPlatform } from '@appdash/shared';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Localization from 'expo-localization';
import { Platform } from 'react-native';

import { log } from './log';

/** `ios` or `android`; anything else (web, windows, macos) is unsupported. */
export function mobilePlatform(os: string = Platform.OS): SdkPlatform | null {
  return os === 'ios' || os === 'android' ? os : null;
}

function safe<T>(read: () => T | null | undefined): string {
  try {
    const v = read();
    return v === null || v === undefined || v === '' ? 'unknown' : String(v);
  } catch (err) {
    log('context: could not read a device value', err);
    return 'unknown';
  }
}

/** Device and app facts sent with every batch. Missing values become 'unknown'. */
export function buildContext(iid: string, platform: SdkPlatform, sdkVersion: string): BatchContext {
  return {
    iid,
    platform,
    osVersion: safe(() => Platform.Version),
    appVersion: safe(() => Application.nativeApplicationVersion),
    build: safe(() => Application.nativeBuildVersion),
    deviceModel: safe(() => Device.modelName),
    locale: safe(() => Localization.getLocales()[0]?.languageTag),
    timezone: safe(() => Localization.getCalendars()[0]?.timeZone),
    sdkVersion,
    bundleId: safe(() => Application.applicationId),
  };
}
