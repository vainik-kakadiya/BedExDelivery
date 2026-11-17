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
});
