import { friendlyName } from '@appmetry/shared';

// Emoji only: the CSP (public/_headers) blocks third-party images such as favicon services.

const CHANNEL_EMOJI: Record<string, string> = {
  Direct: '🔗',
  Organic: '🌱',
  'Organic Search': '🔎',
  'Organic Social': '💬',
  AI: '✨',
  Referral: '↗️',
  Email: '✉️',
  Paid: '💸',
  'Paid Search': '🎯',
};

function Glyph({ children, size = 18 }: { children: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size, fontSize: size * 0.85 }} aria-hidden="true">
      {children}
    </span>
  );
}

export function ChannelIcon({ channel, size }: { channel: string | null; size?: number }) {
  return <Glyph size={size}>{CHANNEL_EMOJI[channel ?? ''] ?? '•'}</Glyph>;
}

export function PlatformIcon({ platform, size }: { platform: string | null; size?: number }) {
  return <Glyph size={size}>{platform === 'ios' ? '🍎' : platform === 'android' ? '🤖' : '📱'}</Glyph>;
}

/** Regional-indicator flag for a two-letter country code. */
export function Flag({ cc, size }: { cc: string | null; size?: number }) {
  const ok = cc && /^[A-Za-z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1';
  return <Glyph size={size}>{ok ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐'}</Glyph>;
}

/** A friendly, stable avatar per install; matches its animal name ("brown fox"). */
export function Avatar({ id, size = 40 }: { id: string; size?: number }) {
  const p = friendlyName(id);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full ring-2 ring-white"
      style={{ width: size, height: size, background: p.color, fontSize: size * 0.55 }}
      title={p.name}
    >
      {p.emoji}
    </span>
  );
}
