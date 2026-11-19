/**
 * ORD-07: address → map location with the Google Geocoding API (GOOGLE_MAPS_SERVER_KEY,
 * with the Geocoding API enabled on the key's project).
 */

export interface GeocodeAddress {
  addressLine1: string;
  addressLine2: string | null;
  town: string;
  postcode: string;
}

export type GeocodeResult =
  /** Found. `precise` is false when Google only matched the postcode or a wider area. */
  | { kind: 'ok'; lat: number; lng: number; precise: boolean }
  /** Google has no match for this address: the office needs to correct it. */
  | { kind: 'not_found' }
  /** Bad key, API not enabled, quota or outage: try again later, don't blame the address. */
  | { kind: 'error'; message: string; retryable: boolean };

export type Geocoder = (address: GeocodeAddress) => Promise<GeocodeResult>;

interface GoogleResponse {
  status: string;
  error_message?: string;
  results?: {
    geometry: { location: { lat: number; lng: number }; location_type: string };
    types: string[];
    partial_match?: boolean;
  }[];
}

type Attempt = { kind: 'ok'; lat: number; lng: number; precise: boolean } | { kind: 'not_found' } | { kind: 'error'; message: string; retryable: boolean };

/** "ME15 6JY" → "ME15": the postcode district, a few km across. */
export const outwardCode = (postcode: string) => postcode.trim().toUpperCase().split(/\s+/)[0] ?? '';

/**
 * Looks the address up in up to three steps, stopping at the first match:
 * 1. the full address, restricted to its postcode (so a typo in the street
 *    can't put the pin in another town);
 * 2. the postcode on its own (Google often can't tie a valid street to a
 *    postcode, e.g. new builds or flats with a building name);
 * 3. the postcode district ("ME15"), for postcodes Google doesn't know.
 * Steps 2 and 3 are marked not precise, so the office sees "approximate" and
 * can drop an exact pin.
 */
export function googleGeocoder(apiKey: string, fetchImpl: typeof fetch = fetch): Geocoder {
  async function lookup(address: string, components: string, accept?: (r: NonNullable<GoogleResponse['results']>[number]) => boolean): Promise<Attempt> {
    const params = new URLSearchParams({ address, components, region: 'gb', key: apiKey });
    let body: GoogleResponse;
    try {
      const res = await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: AbortSignal.timeout(10_000) });
      body = (await res.json()) as GoogleResponse;
    } catch (err) {
      return { kind: 'error', message: `Geocoding request failed: ${(err as Error).message}`, retryable: true };
    }

    if (body.status === 'ZERO_RESULTS') return { kind: 'not_found' };
    if (body.status !== 'OK' || !body.results?.length) {
      const message = `Google Geocoding ${body.status}${body.error_message ? `: ${body.error_message}` : ''}`;
      // REQUEST_DENIED / INVALID_REQUEST won't fix themselves without a config change.
      return { kind: 'error', message, retryable: body.status === 'OVER_QUERY_LIMIT' || body.status === 'UNKNOWN_ERROR' };
    }

    const best = body.results.find((r) => !accept || accept(r));
    if (!best) return { kind: 'not_found' };
    const { lat, lng } = best.geometry.location;
    const precise = best.geometry.location_type === 'ROOFTOP' || best.geometry.location_type === 'RANGE_INTERPOLATED';
    return { kind: 'ok', lat, lng, precise };
  }

  return async (a) => {
    const full = await lookup(
      [a.addressLine1, a.addressLine2, a.town, a.postcode].filter(Boolean).join(', '),
      `country:GB|postal_code:${a.postcode}`,
    );
    if (full.kind !== 'not_found') return full;

    const postcode = await lookup(a.postcode, `country:GB|postal_code:${a.postcode}`);
    if (postcode.kind === 'ok') return { ...postcode, precise: false };
    if (postcode.kind === 'error') return postcode;

    const district = outwardCode(a.postcode);
    if (!district) return { kind: 'not_found' };
    // Only accept a postcode-area match: "ME15, UK" must not resolve to some street or business.
    const area = await lookup(`${district}, ${a.town}`, 'country:GB', (r) => r.types.some((t) => t === 'postal_code' || t === 'postal_code_prefix'));
    if (area.kind === 'ok') return { ...area, precise: false };
    return area;
  };
}
