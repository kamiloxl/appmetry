export const EVENT_TYPES = ['install', 'session_start', 'screen', 'event', 'deep_link', 'identify', 'source', 'ping'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Platform = 'ios' | 'android';

export interface SdkEvent {
  id: string;
  type: EventType;
  ts: number;
  sid: string;
  name?: string;
  props?: Record<string, unknown>;
}
// install.props:  { referrer?: string; referrerClickTs?: number; installBeginTs?: number; asaToken?: string }
// screen/event/source.name = screen / event name / reported answer; deep_link.name = cleaned URL
// identify.props: { userId?: string; email?: string; name?: string };  ping.props: { ms: number }

export interface BatchContext {
  iid: string;
  platform: Platform;
  osVersion: string;
  appVersion: string;
  build: string;
  deviceModel: string;
  locale: string;
  timezone: string;
  sdkVersion: string;
  bundleId: string;
}
export interface Batch {
  context: BatchContext;
  events: SdkEvent[];
}
export type ValidateResult = { ok: true; batch: Batch; dropped: number } | { ok: false; error: string };

export const LIMITS = { maxEvents: 50, maxBodyBytes: 65536, maxPropsChars: 1024, maxName: 255, maxUrl: 500 };

const ID_RE = /^[\w-]{8,64}$/;
const STRING_FIELDS = ['osVersion', 'appVersion', 'build', 'deviceModel', 'locale', 'timezone', 'sdkVersion', 'bundleId'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validateContext(input: unknown): BatchContext | null {
  if (!isObject(input)) return null;
  if (input.platform !== 'ios' && input.platform !== 'android') return null;
  if (typeof input.iid !== 'string' || !ID_RE.test(input.iid)) return null;
  const out: Record<string, unknown> = { iid: input.iid, platform: input.platform };
  for (const f of STRING_FIELDS) {
    const v = input[f];
    if (typeof v !== 'string') return null;
    out[f] = v.slice(0, LIMITS.maxName);
  }
  return out as unknown as BatchContext;
}

function validateEvent(input: unknown): SdkEvent | null {
  if (!isObject(input)) return null;
  const { id, sid, type, ts, name, props } = input;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof sid !== 'string' || !ID_RE.test(sid)) return null;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const event: SdkEvent = { id, type: type as EventType, ts, sid };
  if (typeof name === 'string') {
    event.name = name.slice(0, type === 'deep_link' ? LIMITS.maxUrl : LIMITS.maxName);
  }
  if (props !== undefined && props !== null) {
    if (!isObject(props)) return null;
    let json: string | undefined;
    try {
      json = JSON.stringify(props);
    } catch {
      return null;
    }
    if (json === undefined || json.length > LIMITS.maxPropsChars) return null;
    event.props = props;
  }
  return event;
}

export function validateBatch(input: unknown): ValidateResult {
  if (!isObject(input)) return { ok: false, error: 'invalid_body' };
  const context = validateContext(input.context);
  if (!context) return { ok: false, error: 'invalid_context' };
  const raw = input.events;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.maxEvents) {
    return { ok: false, error: 'invalid_event_count' };
  }
  const events: SdkEvent[] = [];
  for (const e of raw) {
    const v = validateEvent(e);
    if (v) events.push(v);
  }
  return { ok: true, batch: { context, events }, dropped: raw.length - events.length };
}
