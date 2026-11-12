import { describe, expect, it, vi } from 'vitest';
import { buildOptimizeToursRequest, googleLegs, parseDurationSeconds, parseOptimizeToursResponse, parseServiceAccount } from './google';
import type { PlanningModel } from './types';

const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);
const model: PlanningModel = {
  shipments: [
    { orderId: 'order-a', location: { lat: 51.5, lng: -0.2 }, serviceSeconds: 900, demand: 4.2, window: { start: at('09:00'), end: at('12:00') } },
    { orderId: 'order-b', location: { lat: 51.51, lng: -0.21 }, serviceSeconds: 600, demand: 2, window: null },
    { orderId: 'order-c', location: { lat: 51.52, lng: -0.22 }, serviceSeconds: 600, demand: 2, window: { start: at('05:00'), end: at('06:00') } },
  ],
  vehicles: [
    { key: 'driver-1', start: { lat: 51.529, lng: -0.267 }, end: { lat: 51.529, lng: -0.267 }, capacity: 40, startTime: at('08:00'), endTime: at('17:00'), maxDurationSeconds: 36000 },
    { key: 'driver-2', start: { lat: 51.529, lng: -0.267 }, end: null, capacity: 25, startTime: at('07:30'), endTime: at('16:00'), maxDurationSeconds: null },
  ],
};

describe('buildOptimizeToursRequest (RTE-04)', () => {
  const { request, outsideHorizon } = buildOptimizeToursRequest(model);
  const m = request.model as {
    globalStartTime: string;
    globalEndTime: string;
    shipments: Record<string, unknown>[];
    vehicles: Record<string, unknown>[];
  };

  it('sets the horizon from the drivers’ working hours', () => {
    expect(m.globalStartTime).toBe('2026-11-12T07:30:00.000Z');
    expect(m.globalEndTime).toBe('2026-11-12T17:00:00.000Z');
  });

  it('maps orders to shipments with service time, window and integer load', () => {
    expect(m.shipments[0]).toEqual({
      label: 'order-a',
      deliveries: [
        {
          arrivalLocation: { latitude: 51.5, longitude: -0.2 },
          duration: '900s',
          timeWindows: [{ startTime: '2026-11-12T09:00:00.000Z', endTime: '2026-11-12T12:00:00.000Z' }],
        },
      ],
      loadDemands: { units: { amount: '5' } },
    });
    expect((m.shipments[1]!.deliveries as object[])[0]).not.toHaveProperty('timeWindows');
  });

  it('drops shipments whose window is outside every working day', () => {
    expect(outsideHorizon).toEqual(['order-c']);
    expect(m.shipments).toHaveLength(2);
  });

  it('maps drivers + vans to vehicles; "last stop" has no end location', () => {
    expect(m.vehicles[0]).toMatchObject({
      label: 'driver-1',
      startLocation: { latitude: 51.529, longitude: -0.267 },
      endLocation: { latitude: 51.529, longitude: -0.267 },
      loadLimits: { units: { maxLoad: '40' } },
      routeDurationLimit: { maxDuration: '36000s' },
    });
    expect(m.vehicles[1]).not.toHaveProperty('endLocation');
    expect(m.vehicles[1]).not.toHaveProperty('routeDurationLimit');
    expect(request).toMatchObject({ populatePolylines: true, searchMode: 'RETURN_FAST' });
  });

  it('maps the response by label, including omitted zero indexes', () => {
    const result = parseOptimizeToursResponse(
      {
        routes: [
          // vehicleIndex 0 and shipmentIndex 0 are omitted in proto3 JSON.
          {
            vehicleStartTime: '2026-11-12T08:00:00Z',
            vehicleEndTime: '2026-11-12T10:30:00Z',
            visits: [{ startTime: '2026-11-12T09:00:00Z' }, { shipmentIndex: 1, shipmentLabel: 'order-b', startTime: '2026-11-12T09:40:00Z' }],
            transitions: [{ waitDuration: '600s', travelDuration: '1200s', travelDistanceMeters: 8000 }, { travelDuration: '900s', travelDistanceMeters: 5000 }, {}],
            routePolyline: { points: '_p~iF~ps|U' },
            metrics: { travelDuration: '2700s', travelDistanceMeters: 15000 },
          },
          { vehicleIndex: 1, vehicleLabel: 'driver-2' },
        ],
      },
      model,
      request,
    );
    expect(result.engine).toBe('google');
    expect(result.routes).toHaveLength(1);
    const [route] = result.routes;
    expect(route!.vehicleKey).toBe('driver-1');
    expect(route!.visits.map((v) => v.orderId)).toEqual(['order-a', 'order-b']);
    expect(route!.visits[0]!.arrival.toISOString()).toBe('2026-11-12T08:50:00.000Z');
    expect(route!.visits[0]!.departure.toISOString()).toBe('2026-11-12T09:15:00.000Z');
    expect(route!.distanceMeters).toBe(15000);
    expect(route!.travelSeconds).toBe(2700);
    expect(route!.polyline).toBe('_p~iF~ps|U');
  });

  it('maps skipped reasons', () => {
    const result = parseOptimizeToursResponse(
      {
        skippedShipments: [
          { label: 'order-a', reasons: [{ code: 'DEMAND_EXCEEDS_VEHICLE_CAPACITY' }] },
          { index: 1, reasons: [{ code: 'CANNOT_BE_PERFORMED_WITHIN_VEHICLE_TIME_WINDOWS' }] },
          { label: 'order-x' },
        ],
      },
      model,
      request,
    );
    expect(result.skipped).toEqual([
      { orderId: 'order-a', reason: 'capacity' },
      { orderId: 'order-b', reason: 'time_window' },
      { orderId: 'order-x', reason: 'unknown' },
    ]);
  });
});

describe('helpers', () => {
  it('parses protobuf durations', () => {
    expect(parseDurationSeconds('120s')).toBe(120);
    expect(parseDurationSeconds('1.5s')).toBe(1.5);
    expect(parseDurationSeconds(undefined)).toBe(0);
  });

  it('accepts service account JSON raw or base64', () => {
    const json = JSON.stringify({ client_email: 'svc@p.iam.gserviceaccount.com', private_key: 'KEY' });
    expect(parseServiceAccount(json).client_email).toBe('svc@p.iam.gserviceaccount.com');
    expect(parseServiceAccount(Buffer.from(json).toString('base64')).private_key).toBe('KEY');
    expect(() => parseServiceAccount('{}')).toThrow();
  });
});

describe('googleLegs (Routes API)', () => {
  it('splits long routes into ≤25-waypoint calls and stitches legs', async () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ lat: 51.5 + i * 0.001, lng: -0.1 }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { intermediates: unknown[] };
      const legCount = body.intermediates.length + 1;
      return new Response(
        JSON.stringify({ routes: [{ legs: Array.from({ length: legCount }, () => ({ distanceMeters: 100, duration: '30s' })), polyline: { encodedPolyline: '_p~iF~ps|U' } }] }),
      );
    });
    const result = await googleLegs('key', fetchImpl as unknown as typeof fetch)(points);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('key');
    expect(headers['X-Goog-FieldMask']).toContain('routes.legs.duration');
    expect(result.legs).toHaveLength(39);
    expect(result.legs[0]).toEqual({ meters: 100, seconds: 30 });
    expect(result.engine).toBe('google');
  });
});
