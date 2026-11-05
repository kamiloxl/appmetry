import { describe, expect, it } from 'vitest';
import { wrapIndex } from '../src/components/Modal';

describe('wrapIndex (focus trap)', () => {
  it('wraps forward from the last and backward from the first', () => {
    expect(wrapIndex(3, 2, false)).toBe(0);
    expect(wrapIndex(3, 0, true)).toBe(2);
  });
  it('lets the browser move focus in the middle', () => {
    expect(wrapIndex(3, 1, false)).toBeNull();
    expect(wrapIndex(3, 1, true)).toBeNull();
  });
  it('pulls focus in when it is outside the list', () => {
    expect(wrapIndex(3, -1, false)).toBe(0);
    expect(wrapIndex(3, -1, true)).toBe(2);
  });
  it('keeps focus on the dialog when nothing is focusable', () => {
    expect(wrapIndex(0, -1, false)).toBe(-1);
  });
});
