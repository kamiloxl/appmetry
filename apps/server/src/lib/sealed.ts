/**
 * Reversible encryption for third-party credentials and identifiers the server must read back (ad-network tokens,
 * advertising ids). AES-256-GCM via WebCrypto, keyed by the Worker secret INTEGRATIONS_KEY (32 bytes, base64).
 *
 * Envelope: `v1.<kid>.<iv>.<ciphertext>` (base64url parts). `kid` is the first 8 hex chars of SHA-256(key), so after a
 * rotation INTEGRATIONS_KEY_PREVIOUS still opens older values. The `context` string is bound as AES-GCM additional
 * data, so a value copied to another row or field does not open.
 *
 * Without a valid key, features that need it are unavailable (fail closed): nothing is stored in plain text instead.
 */

export class SealUnavailableError extends Error {
  constructor() {
    super('INTEGRATIONS_KEY is not set or is not 32 bytes of base64');
    this.name = 'SealUnavailableError';
  }
}

export interface SealKeys {
  current: string;
  previous: string | null;
}

export interface SealEnv {
  INTEGRATIONS_KEY?: string;
  INTEGRATIONS_KEY_PREVIOUS?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const validKey = (k: string | undefined): k is string => typeof k === 'string' && b64ToBytes(k.trim())?.length === 32;

/** The usable keys from the environment, or null when INTEGRATIONS_KEY is missing or not 32 bytes. */
export function parseKeys(env: SealEnv): SealKeys | null {
  if (!validKey(env.INTEGRATIONS_KEY)) return null;
  return {
    current: env.INTEGRATIONS_KEY.trim(),
    previous: validKey(env.INTEGRATIONS_KEY_PREVIOUS) ? env.INTEGRATIONS_KEY_PREVIOUS.trim() : null,
  };
}

const imported = new Map<string, Promise<{ kid: string; key: CryptoKey }>>();

/** Imported keys are cached per isolate. */
function importKey(b64: string): Promise<{ kid: string; key: CryptoKey }> {
  let p = imported.get(b64);
  if (!p) {
    p = (async () => {
      const raw = b64ToBytes(b64)!;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      const kid = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
      const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      return { kid, key };
    })();
    imported.set(b64, p);
  }
  return p;
}

export async function seal(keys: SealKeys | null, plaintext: string, context: string): Promise<string> {
  if (!keys) throw new SealUnavailableError();
  const { kid, key } = await importKey(keys.current);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, key, enc.encode(plaintext));
  return `v1.${kid}.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`;
}

export async function open(keys: SealKeys | null, envelope: string, context: string): Promise<string> {
  if (!keys) throw new SealUnavailableError();
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid sealed value');
  const [, kid, ivPart, ctPart] = parts;
  const iv = b64ToBytes(ivPart);
  const ct = b64ToBytes(ctPart);
  if (!iv || iv.length !== 12 || !ct) throw new Error('invalid sealed value');

  for (const candidate of [keys.current, keys.previous]) {
    if (!candidate) continue;
    const k = await importKey(candidate);
    if (k.kid !== kid) continue;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, k.key, ct);
    return dec.decode(pt);
  }
  throw new Error('no key matches this sealed value');
}
