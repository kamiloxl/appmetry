import { Platform } from 'react-native';
import AppdashAttributionModule from './AppdashAttributionModule';

const toMs = (seconds: unknown): number | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const ms = Math.round(seconds * 1000);
  return ms > 0 ? ms : undefined;
};

/**
 * Install-time attribution inputs: Apple AdServices token (iOS) or Play Install
 * Referrer (Android). Keys without a value are omitted. Never throws.
 */
export async function collectInstallProps(): Promise<Record<string, unknown>> {
  try {
    const mod = AppdashAttributionModule;
    if (!mod) return {};
    const props: Record<string, unknown> = {};

    if (Platform.OS === 'ios') {
      const token = await mod.getAdServicesToken?.();
      if (typeof token === 'string' && token.length > 0) props.asaToken = token;
    } else if (Platform.OS === 'android') {
      const r = await mod.getInstallReferrer?.();
      if (r) {
        if (typeof r.referrer === 'string' && r.referrer.length > 0) props.referrer = r.referrer;
        const click = toMs(r.clickTs);
        if (click !== undefined) props.referrerClickTs = click;
        const begin = toMs(r.installTs);
        if (begin !== undefined) props.installBeginTs = begin;
      }
    }
    return props;
  } catch {
    return {};
  }
}
