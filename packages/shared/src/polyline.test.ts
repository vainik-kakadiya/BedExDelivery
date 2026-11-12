import { describe, expect, it } from 'vitest';
import { londonToUtc } from './format';
import { decodePolyline, encodePolyline } from './polyline';

describe('polyline', () => {
  // Example from Google's encoded polyline documentation.
  const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const points = [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ];

  it('decodes the documented example', () => {
    expect(decodePolyline(encoded)).toEqual(points);
  });

  it('encodes the documented example', () => {
    expect(encodePolyline(points)).toBe(encoded);
  });

  it('round-trips London coordinates', () => {
    const london = [
      { lat: 51.529, lng: -0.267 },
      { lat: 51.50721, lng: -0.12758 },
      { lat: 51.4213, lng: 0.0012 },
    ];
    expect(decodePolyline(encodePolyline(london))).toEqual(london);
  });

  it('does not hang on malformed input', () => {
    expect(() => decodePolyline('~')).not.toThrow();
  });
});

describe('londonToUtc', () => {
  it('handles GMT (winter)', () => {
    expect(londonToUtc('2026-11-12', '08:00').toISOString()).toBe('2026-11-12T08:00:00.000Z');
  });

  it('handles BST (summer)', () => {
    expect(londonToUtc('2026-07-01', '08:00').toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('handles the days the clocks change', () => {
    // 29 Mar 2026: clocks go forward at 01:00 GMT.
    expect(londonToUtc('2026-03-29', '09:00').toISOString()).toBe('2026-03-29T08:00:00.000Z');
    // 25 Oct 2026: clocks go back at 02:00 BST.
    expect(londonToUtc('2026-10-25', '09:00').toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });

  it('accepts HH:MM:SS from Postgres time columns', () => {
    expect(londonToUtc('2026-11-12', '17:30:00').toISOString()).toBe('2026-11-12T17:30:00.000Z');
  });
});
