import { describe, expect, it } from 'vitest';
import { open, parseKeys, seal, SealUnavailableError } from '../src/lib/sealed';

// 32 bytes, base64.
const KEY_A = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const KEY_B = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

describe('sealed values (AES-GCM envelope)', () => {
  it('round-trips with the same key and context', async () => {
    const keys = parseKeys({ INTEGRATIONS_KEY: KEY_A });
    const ct = await seal(keys, 'EAAG-token', 'integration:i1:capi');
    expect(ct).toMatch(/^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+$/);
    expect(ct).not.toContain('EAAG');
    expect(await open(keys, ct, 'integration:i1:capi')).toBe('EAAG-token');
  });

  it('uses a fresh IV for every encryption', async () => {
    const keys = parseKeys({ INTEGRATIONS_KEY: KEY_A });
    expect(await seal(keys, 'same', 'ctx')).not.toBe(await seal(keys, 'same', 'ctx'));
  });

  it('rejects a ciphertext moved to another context', async () => {
    const keys = parseKeys({ INTEGRATIONS_KEY: KEY_A });
    const ct = await seal(keys, 'value', 'integration:i1:capi');
    await expect(open(keys, ct, 'integration:i2:capi')).rejects.toThrow();
  });

  it('rejects a tampered ciphertext', async () => {
    const keys = parseKeys({ INTEGRATIONS_KEY: KEY_A });
    const parts = (await seal(keys, 'value', 'ctx')).split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    await expect(open(keys, parts.join('.'), 'ctx')).rejects.toThrow();
  });

  it('opens with the previous key after rotation; new values use the current key', async () => {
    const old = await seal(parseKeys({ INTEGRATIONS_KEY: KEY_A }), 'value', 'ctx');
    const rotated = parseKeys({ INTEGRATIONS_KEY: KEY_B, INTEGRATIONS_KEY_PREVIOUS: KEY_A });
    expect(await open(rotated, old, 'ctx')).toBe('value');
    const fresh = await seal(rotated, 'value', 'ctx');
    expect(fresh.split('.')[1]).not.toBe(old.split('.')[1]);
  });

  it('fails with the wrong key', async () => {
    const ct = await seal(parseKeys({ INTEGRATIONS_KEY: KEY_A }), 'value', 'ctx');
    await expect(open(parseKeys({ INTEGRATIONS_KEY: KEY_B }), ct, 'ctx')).rejects.toThrow();
  });

  it('is unavailable without a valid key (fail closed)', async () => {
    expect(parseKeys({})).toBeNull();
    expect(parseKeys({ INTEGRATIONS_KEY: 'too-short' })).toBeNull();
    await expect(seal(null, 'x', 'ctx')).rejects.toBeInstanceOf(SealUnavailableError);
    await expect(open(null, 'v1.00000000.a.b', 'ctx')).rejects.toBeInstanceOf(SealUnavailableError);
  });
});
