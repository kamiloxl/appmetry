import { ATT_STATUSES, type AttStatus } from '@appmetry/shared';
import { Platform } from 'react-native';
import AppmetryAttributionModule from './AppmetryAttributionModule';

const toMs = (seconds: unknown): number | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const ms = Math.round(seconds * 1000);
  return ms > 0 ? ms : undefined;
};

type Deps = { module: typeof AppmetryAttributionModule; os: string };

/**
 * Install-time attribution inputs: Apple AdServices token (iOS) or Play Install
 * Referrer (Android). Keys without a value are omitted. Never throws.
 */
export async function collectInstallProps(
  deps: Deps = { module: AppmetryAttributionModule, os: Platform.OS },
): Promise<Record<string, unknown>> {
  try {
    const mod = deps.module;
    if (!mod) return {};
    const props: Record<string, unknown> = {};

    if (deps.os === 'ios') {
      const token = await mod.getAdServicesToken?.();
      if (typeof token === 'string' && token.length > 0) props.asaToken = token;
    } else if (deps.os === 'android') {
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

/** Ad consent as reported to the server with install and consent events. */
export interface AdSignals {
  adConsent: boolean;
  /** iOS only. */
  att?: AttStatus;
  /** IDFA / GAID: only with ad consent, and on iOS only when ATT is authorized. */
  madid?: string;
}

const MADID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_MADID = '00000000-0000-0000-0000-000000000000';

/**
 * The app's ad consent plus the ATT status (iOS) and, only with consent, the advertising id. The SDK never shows the
 * ATT prompt: the app does that. Never throws.
 */
export async function collectAdSignals(
  adConsent: boolean,
  deps: Deps = { module: AppmetryAttributionModule, os: Platform.OS },
): Promise<AdSignals> {
  const out: AdSignals = { adConsent };
  try {
    const mod = deps.module;
    if (!mod) return out;
    if (deps.os === 'ios') {
      const att = await mod.getTrackingAuthorizationStatus?.();
      if (typeof att === 'string' && (ATT_STATUSES as readonly string[]).includes(att)) out.att = att as AttStatus;
      if (!adConsent || out.att !== 'authorized') return out;
    } else if (deps.os !== 'android' || !adConsent) {
      return out;
    }
    const id = await mod.getAdvertisingId?.();
    if (typeof id === 'string' && MADID_RE.test(id) && id !== ZERO_MADID) out.madid = id;
  } catch {
    // Signals are best effort.
  }
  return out;
}
