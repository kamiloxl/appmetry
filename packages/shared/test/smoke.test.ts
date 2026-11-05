import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index';

describe('smoke', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
