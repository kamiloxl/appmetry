export interface Touch {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  ref?: string;
  click_id?: string;
}

// Ported from datalog public/js/script.js: personal data in URLs never leaves the device.
export const PRIVATE_PARAM =
  /^(e-?mail|name|phone|password|pass|token|access_token|id_token|auth|code|secret|key|api_key|license_key|license)$/i;

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

// Manual split: custom schemes (myapp://x?...) are not reliably handled by URL in React Native.
function split(url: string): { base: string; query: string } {
  const h = url.indexOf('#');
  const rest = h >= 0 ? url.slice(0, h) : url;
  const q = rest.indexOf('?');
  return q >= 0
    ? { base: rest.slice(0, q), query: rest.slice(q + 1) }
    : { base: rest, query: '' };
}

export function stripPrivateParams(url: string): string {
  if (typeof url !== 'string') return url;
  const { base, query } = split(url);
  if (!query) return base; // fragment is always dropped: it can carry tokens and is never used for attribution
  const kept = query.split('&').filter((pair) => {
    if (!pair) return false;
    const eq = pair.indexOf('=');
    return !PRIVATE_PARAM.test(decode(eq >= 0 ? pair.slice(0, eq) : pair));
  });
  return base + (kept.length ? '?' + kept.join('&') : '');
}

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

export function touchFromQuery(query: string): Touch {
  const touch: Touch = {};
  let via: string | undefined;
  for (const pair of query.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decode(eq >= 0 ? pair.slice(0, eq) : pair);
    const v = decode(eq >= 0 ? pair.slice(eq + 1) : '');
    if (!v) continue;
    if ((UTM as readonly string[]).includes(k)) touch[k as (typeof UTM)[number]] = v;
    else if (k === 'ref') touch.ref = v;
    else if (k === 'via') via = v;
    else if (k === 'click_id') touch.click_id = v;
  }
  if (touch.ref === undefined && via !== undefined) touch.ref = via;
  return touch;
}

export function extractTouch(url: string): Touch | null {
  const touch = touchFromQuery(split(url).query);
  return Object.keys(touch).length ? touch : null;
}
