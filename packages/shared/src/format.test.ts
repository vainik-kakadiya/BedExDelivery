import { describe, expect, it } from 'vitest';
import { formatUkDate, normalisePhone, normalisePostcode, postcodesMatch, toLondonDate } from './format';
import { generateTrackingRef, normaliseTrackingRef } from './trackingRef';

describe('postcodes', () => {
  it.each([
    ['sw1a1aa', 'SW1A 1AA'],
    [' SW1A  1AA ', 'SW1A 1AA'],
    ['m11ae', 'M1 1AE'],
    ['b338th', 'B33 8TH'],
    ['cr26xh', 'CR2 6XH'],
    ['dn551pt', 'DN55 1PT'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalisePostcode(input)).toBe(expected);
  });

  it.each(['', 'ABC', '12345', 'SW1A1A', 'SW1A 1AAA'])('rejects %s', (input) => {
    expect(normalisePostcode(input)).toBeNull();
  });

  it('matches case- and space-insensitively', () => {
    expect(postcodesMatch('sw1a1aa', 'SW1A 1AA')).toBe(true);
    expect(postcodesMatch('SW1A 1AB', 'SW1A 1AA')).toBe(false);
  });
});

describe('phones', () => {
  it.each([
    ['07700 900123', '+447700900123'],
    ['+44 7700 900123', '+447700900123'],
    ['0044 7700 900123', '+447700900123'],
    ['447700900123', '+447700900123'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });
});

describe('dates', () => {
  it('uses Europe/London for "today" across the BST boundary', () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July.
    expect(toLondonDate(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
    // 23:30 UTC on 30 Dec is still 30 Dec in GMT.
    expect(toLondonDate(new Date('2026-12-30T23:30:00Z'))).toBe('2026-12-30');
  });

  it('formats DD/MM/YYYY', () => {
    expect(formatUkDate('2026-11-12')).toBe('12/11/2026');
  });
});

describe('tracking references', () => {
  it('generates BDX + 9 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTrackingRef()).toMatch(/^BDX[A-HJ-NP-Z2-9]{9}$/);
    }
  });

  it('is unique across many draws', () => {
    const refs = new Set(Array.from({ length: 5000 }, () => generateTrackingRef()));
    expect(refs.size).toBe(5000);
  });

  it('normalises user input', () => {
    expect(normaliseTrackingRef(' bdx abc 123 ')).toBe('BDXABC123');
  });
});
