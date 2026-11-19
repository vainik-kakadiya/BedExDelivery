import { describe, expect, it } from 'vitest';
import { googleGeocoder } from './geocoder';

const address = { addressLine1: '36 Albert Reed Gardens', addressLine2: null, town: 'Maidstone', postcode: 'ME15 6JY' };

function fakeFetch(body: unknown, seen: string[] = []) {
  return (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

describe('googleGeocoder', () => {
  it('returns the location and restricts the search to the UK postcode', async () => {
    const seen: string[] = [];
    const geocode = googleGeocoder(
      'key',
      fakeFetch({ status: 'OK', results: [{ geometry: { location: { lat: 51.26, lng: 0.51 }, location_type: 'ROOFTOP' }, types: [] }] }, seen),
    );
    expect(await geocode(address)).toEqual({ kind: 'ok', lat: 51.26, lng: 0.51, precise: true });
    const params = new URL(seen[0]!).searchParams;
    expect(params.get('address')).toBe('36 Albert Reed Gardens, Maidstone, ME15 6JY');
    expect(params.get('components')).toBe('country:GB|postal_code:ME15 6JY');
  });

  it('flags postcode-level matches as not precise', async () => {
    const geocode = googleGeocoder(
      'key',
      fakeFetch({ status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: 'APPROXIMATE' }, types: ['postal_code'] }] }),
    );
    expect(await geocode(address)).toMatchObject({ kind: 'ok', precise: false });
  });

  it('reports addresses Google cannot find', async () => {
    expect(await googleGeocoder('key', fakeFetch({ status: 'ZERO_RESULTS', results: [] }))(address)).toEqual({ kind: 'not_found' });
  });

  it('treats a rejected key as a non-retryable error, not a bad address', async () => {
    const result = await googleGeocoder('key', fakeFetch({ status: 'REQUEST_DENIED', error_message: 'API not enabled' }))(address);
    expect(result).toEqual({ kind: 'error', message: 'Google Geocoding REQUEST_DENIED: API not enabled', retryable: false });
  });

  it('retries on quota errors and network failures', async () => {
    expect(await googleGeocoder('key', fakeFetch({ status: 'OVER_QUERY_LIMIT' }))(address)).toMatchObject({ kind: 'error', retryable: true });
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await googleGeocoder('key', failing)(address)).toMatchObject({ kind: 'error', retryable: true });
  });

  it('falls back to the postcode, then the postcode district, marked approximate', async () => {
    const seen: string[] = [];
    const replies = [
      { status: 'ZERO_RESULTS', results: [] },
      { status: 'OK', results: [{ geometry: { location: { lat: 51.25, lng: 0.52 }, location_type: 'APPROXIMATE' }, types: ['postal_code'] }] },
    ];
    const sequence = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(replies.shift() ?? { status: 'ZERO_RESULTS' }));
    }) as unknown as typeof fetch;
    expect(await googleGeocoder('key', sequence)(address)).toEqual({ kind: 'ok', lat: 51.25, lng: 0.52, precise: false });
    expect(new URL(seen[1]!).searchParams.get('address')).toBe('ME15 6JY');
  });

  it('only accepts a postcode-area match for the district step', async () => {
    const seen: string[] = [];
    const replies = [
      { status: 'ZERO_RESULTS' },
      { status: 'ZERO_RESULTS' },
      {
        status: 'OK',
        results: [
          { geometry: { location: { lat: 9, lng: 9 }, location_type: 'GEOMETRIC_CENTER' }, types: ['establishment'] },
          { geometry: { location: { lat: 51.2, lng: 0.5 }, location_type: 'APPROXIMATE' }, types: ['postal_code_prefix', 'postal_code'] },
        ],
      },
    ];
    const sequence = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(replies.shift()));
    }) as unknown as typeof fetch;
    expect(await googleGeocoder('key', sequence)(address)).toEqual({ kind: 'ok', lat: 51.2, lng: 0.5, precise: false });
    expect(new URL(seen[2]!).searchParams.get('address')).toBe('ME15, Maidstone');
  });
});
