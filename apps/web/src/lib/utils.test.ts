import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conditional classes and resolves tailwind conflicts', () => {
    const hidden = false as boolean;
    expect(cn('p-2', hidden && 'hidden', 'p-4')).toBe('p-4');
    expect(cn('a', ['b', { c: true, d: false }])).toBe('a b c');
  });
});
