/** Click-to-filter: choosing the active value again clears that dimension; any other value sets or replaces it. */
export function toggleFilter(f: Record<string, string>, dim: string, value: string): Record<string, string> {
  const next = { ...f };
  if (next[dim] === value) delete next[dim];
  else next[dim] = value;
  return next;
}
