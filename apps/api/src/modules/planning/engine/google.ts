/**
 * Google Maps Platform providers.
 * - Route Optimization API (optimizeTours): needs OAuth, so a service account
 *   (GOOGLE_SERVICE_ACCOUNT_JSON) + GOOGLE_CLOUD_PROJECT_ID. API keys are not accepted.
 * - Routes API (computeRoutes): GOOGLE_MAPS_SERVER_KEY (restrict it by server IP).
 * Request/response shapes follow the v1 / v2 REST docs; proto3 JSON omits
 * zero/default fields, so results are mapped back by label, never by index alone.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { decodePolyline, encodePolyline } from '@bedex/shared';
import type { LatLng, LegsResult, OptimiseResult, PlanningModel, SkipReason } from './types';

const OPTIMIZE_TIMEOUT_SECONDS = 25;
const ROUTES_MAX_INTERMEDIATES = 25;

// ---------- auth ----------

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Accepts raw JSON or base64-encoded JSON (easier to keep on one env line). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text) as Partial<ServiceAccount>;
  if (!json.client_email || !json.private_key) throw new Error('Service account JSON needs client_email and private_key');
  return { client_email: json.client_email, private_key: json.private_key };
}

export function createTokenSource(account: ServiceAccount, fetchImpl: typeof fetch = fetch) {
  let cached: { token: string; expiresAt: number } | null = null;
  return async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/cloud-platform' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Google OAuth failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  };
}

/*
 * On a Google Cloud VM the API can use the VM's own service account through the
 * metadata server, so no key file is needed. Many organisations block key
 * creation (iam.disableServiceAccountKeyCreation), and keyless is safer anyway.
 * The VM needs the "cloud-platform" access scope, and its service account needs
 * the Route Optimization Editor role (see deploy/google-cloud.md).
 */
const METADATA_ACCOUNT = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface MetadataAccount {
  email: string;
  /** False when the VM's access scopes don't allow Cloud APIs: tokens would be refused. */
  cloudPlatformScope: boolean;
}

/** The VM's service account, or null when not running on Google Cloud. */
export async function detectMetadataAccount(fetchImpl: typeof fetch = fetch): Promise<MetadataAccount | null> {
  try {
    const get = (path: string) => fetchImpl(`${METADATA_ACCOUNT}/${path}`, { headers: METADATA_HEADERS, signal: AbortSignal.timeout(2_000) });
    const [email, scopes] = await Promise.all([get('email'), get('scopes')]);
    if (!email.ok || !scopes.ok || email.headers.get('Metadata-Flavor') !== 'Google') return null;
    return { email: (await email.text()).trim(), cloudPlatformScope: (await scopes.text()).split(/\s+/).includes(CLOUD_PLATFORM_SCOPE) };
  } catch {
    return null;
  }
}

export function metadataTokenSource(fetchImpl: typeof fetch = fetch) {
  let cached: { token: string; expiresAt: number } | null = null;
  return async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const res = await fetchImpl(`${METADATA_ACCOUNT}/token`, { headers: METADATA_HEADERS, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Google OAuth failed (metadata server ${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  };
}

// ---------- Route Optimization: request ----------

const latLng = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });
const seconds = (s: number) => `${Math.round(s)}s`;
const iso = (d: Date) => d.toISOString();

export interface OptimizeToursRequest {
  model: Record<string, unknown>;
  [key: string]: unknown;
}

/** RTE-04: shipments = orders, vehicles = driver + van; minimise time then distance. */
export function buildOptimizeToursRequest(model: PlanningModel): {
  request: OptimizeToursRequest;
  outsideHorizon: string[];
} {
  const globalStart = new Date(Math.min(...model.vehicles.map((v) => v.startTime.getTime())));
  const globalEnd = new Date(Math.max(...model.vehicles.map((v) => v.endTime.getTime())));

  // Windows must sit inside the global horizon; ones that can't are reported as skipped.
  const outsideHorizon: string[] = [];
  const shipments = model.shipments.flatMap((s) => {
    let window = s.window;
    if (window) {
      const start = new Date(Math.max(window.start.getTime(), globalStart.getTime()));
      const end = new Date(Math.min(window.end.getTime(), globalEnd.getTime()));
      if (start > end) {
        outsideHorizon.push(s.orderId);
        return [];
      }
      window = { start, end };
    }
    return [
      {
        label: s.orderId,
        deliveries: [
          {
            arrivalLocation: latLng(s.location),
            duration: seconds(s.serviceSeconds),
            ...(window && { timeWindows: [{ startTime: iso(window.start), endTime: iso(window.end) }] }),
          },
        ],
        loadDemands: { units: { amount: String(Math.ceil(s.demand)) } },
      },
    ];
  });

  const vehicles = model.vehicles.map((v) => ({
    label: v.key,
    travelMode: 'DRIVING',
    startLocation: latLng(v.start),
    ...(v.end && { endLocation: latLng(v.end) }),
    ...(v.capacity !== null && { loadLimits: { units: { maxLoad: String(Math.floor(v.capacity)) } } }),
    startTimeWindows: [{ startTime: iso(v.startTime), endTime: iso(v.endTime) }],
    endTimeWindows: [{ startTime: iso(v.startTime), endTime: iso(v.endTime) }],
    ...(v.maxDurationSeconds !== null && { routeDurationLimit: { maxDuration: seconds(v.maxDurationSeconds) } }),
    // Time is the main cost; distance breaks ties (and saves fuel).
    costPerHour: 60,
    costPerKilometer: 0.5,
  }));

  return {
    request: {
      model: { globalStartTime: iso(globalStart), globalEndTime: iso(globalEnd), shipments, vehicles },
      searchMode: 'RETURN_FAST',
      considerRoadTraffic: false,
      populatePolylines: true,
      timeout: seconds(OPTIMIZE_TIMEOUT_SECONDS),
    },
    outsideHorizon,
  };
}

// ---------- Route Optimization: response ----------

interface GVisit {
  shipmentIndex?: number;
  shipmentLabel?: string;
  startTime?: string;
}
interface GTransition {
  waitDuration?: string;
  travelDuration?: string;
  travelDistanceMeters?: number;
}
interface GRoute {
  vehicleIndex?: number;
  vehicleLabel?: string;
  vehicleStartTime?: string;
  vehicleEndTime?: string;
  visits?: GVisit[];
  transitions?: GTransition[];
  routePolyline?: { points?: string };
  metrics?: { travelDuration?: string; travelDistanceMeters?: number };
}
interface GSkipped {
  index?: number;
  label?: string;
  reasons?: { code?: string }[];
}
export interface OptimizeToursResponse {
  routes?: GRoute[];
  skippedShipments?: GSkipped[];
}

export const parseDurationSeconds = (d: string | undefined) => (d ? Number.parseFloat(d.replace(/s$/, '')) : 0);

const SKIP_CODES: Record<string, SkipReason> = {
  NO_VEHICLE: 'no_vehicle',
  DEMAND_EXCEEDS_VEHICLE_CAPACITY: 'capacity',
  CANNOT_BE_PERFORMED_WITHIN_VEHICLE_TIME_WINDOWS: 'time_window',
  CANNOT_BE_PERFORMED_WITHIN_VEHICLE_DURATION_LIMIT: 'working_hours',
  CANNOT_BE_PERFORMED_WITHIN_VEHICLE_TRAVEL_DURATION_LIMIT: 'working_hours',
  CANNOT_BE_PERFORMED_WITHIN_VEHICLE_DISTANCE_LIMIT: 'working_hours',
};

/** `request` is the payload actually sent: its shipment order is what indexes refer to. */
export function parseOptimizeToursResponse(
  json: OptimizeToursResponse,
  model: PlanningModel,
  request: OptimizeToursRequest,
): OptimiseResult {
  const sentShipments = (request.model.shipments as { label: string }[]).map((s) => s.label);
  const byOrder = new Map(model.shipments.map((s) => [s.orderId, s]));

  const routes = (json.routes ?? [])
    .filter((r) => (r.visits?.length ?? 0) > 0)
    .map((r) => {
      const vehicleKey = r.vehicleLabel ?? model.vehicles[r.vehicleIndex ?? 0]!.key;
      const visits = (r.visits ?? []).map((v, i) => {
        const orderId = v.shipmentLabel ?? sentShipments[v.shipmentIndex ?? 0]!;
        const start = new Date(v.startTime ?? r.vehicleStartTime ?? 0);
        const wait = parseDurationSeconds(r.transitions?.[i]?.waitDuration);
        const service = byOrder.get(orderId)?.serviceSeconds ?? 0;
        return {
          orderId,
          arrival: new Date(start.getTime() - wait * 1000),
          start,
          departure: new Date(start.getTime() + service * 1000),
        };
      });
      const transitions = r.transitions ?? [];
      return {
        vehicleKey,
        visits,
        startTime: new Date(r.vehicleStartTime ?? visits[0]!.arrival),
        endTime: new Date(r.vehicleEndTime ?? visits.at(-1)!.departure),
        distanceMeters: r.metrics?.travelDistanceMeters ?? transitions.reduce((n, t) => n + (t.travelDistanceMeters ?? 0), 0),
        travelSeconds: r.metrics?.travelDuration
          ? parseDurationSeconds(r.metrics.travelDuration)
          : transitions.reduce((n, t) => n + parseDurationSeconds(t.travelDuration), 0),
        polyline: r.routePolyline?.points ?? null,
      };
    });

  const skipped = (json.skippedShipments ?? []).map((s) => ({
    orderId: s.label ?? sentShipments[s.index ?? 0]!,
    reason: SKIP_CODES[s.reasons?.[0]?.code ?? ''] ?? ('unknown' as SkipReason),
  }));
  return { routes, skipped, engine: 'google' };
}

export function googleOptimiser(projectId: string, accessToken: () => Promise<string>, fetchImpl: typeof fetch = fetch) {
  return async (model: PlanningModel): Promise<OptimiseResult> => {
    const { request, outsideHorizon } = buildOptimizeToursRequest(model);
    const res = await fetchImpl(`https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:optimizeTours`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout((OPTIMIZE_TIMEOUT_SECONDS + 15) * 1000),
    });
    if (!res.ok) throw new Error(`Route Optimization API error (${res.status}): ${(await res.text()).slice(0, 500)}`);
    const result = parseOptimizeToursResponse((await res.json()) as OptimizeToursResponse, model, request);
    result.skipped.push(...outsideHorizon.map((orderId) => ({ orderId, reason: 'time_window' as const })));
    return result;
  };
}

// ---------- Routes API (RTE-07 recalculation) ----------

interface ComputeRoutesResponse {
  routes?: { legs?: { distanceMeters?: number; duration?: string }[]; polyline?: { encodedPolyline?: string } }[];
}

/** Road legs for consecutive points; long routes are split into ≤25-waypoint calls and stitched. */
export function googleLegs(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async (points: LatLng[]): Promise<LegsResult> => {
    if (points.length < 2) return { legs: [], polyline: null, engine: 'google' };
    const chunkSize = ROUTES_MAX_INTERMEDIATES + 2;
    const legs: LegsResult['legs'] = [];
    const path: LatLng[] = [];

    for (let from = 0; from < points.length - 1; from += chunkSize - 1) {
      const chunk = points.slice(from, from + chunkSize);
      const waypoint = (p: LatLng) => ({ location: { latLng: latLng(p) } });
      const res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.legs.duration,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify({
          origin: waypoint(chunk[0]!),
          destination: waypoint(chunk.at(-1)!),
          intermediates: chunk.slice(1, -1).map(waypoint),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
          polylineQuality: 'OVERVIEW',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Routes API error (${res.status}): ${(await res.text()).slice(0, 500)}`);
      const route = ((await res.json()) as ComputeRoutesResponse).routes?.[0];
      if (!route?.legs) throw new Error('Routes API returned no route');
      for (const leg of route.legs) legs.push({ meters: leg.distanceMeters ?? 0, seconds: parseDurationSeconds(leg.duration) });
      if (route.polyline?.encodedPolyline) path.push(...decodePolyline(route.polyline.encodedPolyline));
    }
    return { legs, polyline: path.length ? encodePolyline(path) : null, engine: 'google' };
  };
}
