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

export function googleGeocoder(apiKey: string, fetchImpl: typeof fetch = fetch): Geocoder {
  return async (a) => {
    const params = new URLSearchParams({
      address: [a.addressLine1, a.addressLine2, a.town, a.postcode].filter(Boolean).join(', '),
      // Only accept UK results inside the order's postcode, so a typo in the street
      // can't put the pin in another town.
      components: `country:GB|postal_code:${a.postcode}`,
      region: 'gb',
      key: apiKey,
    });
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

    const best = body.results[0]!;
    const { lat, lng } = best.geometry.location;
    const precise = best.geometry.location_type === 'ROOFTOP' || best.geometry.location_type === 'RANGE_INTERPOLATED';
    return { kind: 'ok', lat, lng, precise };
  };
}
