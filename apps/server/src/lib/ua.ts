/** Platform of a browser that opened a tracked link, used to pick the store to redirect to. */
export function platformFromUA(ua: string): 'ios' | 'android' | 'other' {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
