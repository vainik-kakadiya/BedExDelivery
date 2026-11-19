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
    expect(new URL(seen[3]!).searchParams.get('address')).toBe('ME15');
    expect(new URL(seen[3]!).searchParams.get('components')).toBe('country:GB|postal_code:ME15');
  });

  // Real case: Google doesn't know the new-build postcode HP22 3DA, but does know the street.
  describe('postcodes Google does not know', () => {
    const newBuild = { addressLine1: '15 Bakewell Drive', addressLine2: 'Weston Turville', town: 'Aylesbury', postcode: 'HP22 3DA' };
    const streetResult = (components: { long_name: string; types: string[] }[]) => ({
      status: 'OK',
      results: [
        {
          geometry: { location: { lat: 51.7998, lng: -0.7778 }, location_type: 'RANGE_INTERPOLATED' },
          types: ['street_address'],
          address_components: components.map((c) => ({ ...c, short_name: c.long_name })),
        },
      ],
    });
    const run = async (third: unknown) => {
      const seen: string[] = [];
      const replies = [{ status: 'ZERO_RESULTS' }, { status: 'ZERO_RESULTS' }, third, { status: 'ZERO_RESULTS' }];
      const sequence = (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify(replies.shift()));
      }) as unknown as typeof fetch;
      return { result: await googleGeocoder('key', sequence)(newBuild), seen };
    };

    it('finds the street without the postcode filter when the town matches', async () => {
      const { result, seen } = await run(
        streetResult([
          { long_name: 'Weston Turville', types: ['locality'] },
          { long_name: 'Aylesbury', types: ['postal_town'] },
        ]),
      );
      expect(result).toEqual({ kind: 'ok', lat: 51.7998, lng: -0.7778, precise: true });
      expect(new URL(seen[2]!).searchParams.get('components')).toBe('country:GB');
    });

    it('accepts a match in the same postcode district', async () => {
      const { result } = await run(streetResult([{ long_name: 'HP22 3DB', types: ['postal_code'] }]));
      expect(result).toMatchObject({ kind: 'ok', precise: true });
    });

    it('rejects a same-named street in another town or district', async () => {
      expect((await run(streetResult([{ long_name: 'Derby', types: ['postal_town'] }]))).result).toEqual({ kind: 'not_found' });
      expect((await run(streetResult([{ long_name: 'DE1 2AB', types: ['postal_code'] }]))).result).toEqual({ kind: 'not_found' });
    });
  });
});
