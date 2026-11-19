import { describe, expect, it } from 'vitest';
import { estimateLeg, haversineMeters, optimiseLocally, simulate } from './estimate';
import type { ShipmentSpec, VehicleSpec } from './types';

const DEPOT = { lat: 51.529, lng: -0.267 };
const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);

const vehicle = (key: string, overrides: Partial<VehicleSpec> = {}): VehicleSpec => ({
  key,
  start: DEPOT,
  end: DEPOT,
  capacity: 40,
  startTime: at('08:00'),
  endTime: at('17:00'),
  maxDurationSeconds: 10 * 3600,
  ...overrides,
});

// A ring of 12 stops ~3–6 km around the depot.
const ring: ShipmentSpec[] = Array.from({ length: 12 }, (_, i) => {
  const angle = (i / 12) * 2 * Math.PI;
  const r = 0.03 + (i % 3) * 0.01;
  return {
    orderId: `o${i}`,
    location: { lat: DEPOT.lat + r * Math.sin(angle), lng: DEPOT.lng + r * 1.6 * Math.cos(angle) },
    serviceSeconds: 900,
    demand: 4,
    window: null,
  };
});

describe('travel estimate', () => {
  it('measures straight-line distance', () => {
    // Park Royal → Charing Cross is ~10 km as the crow flies.
    expect(haversineMeters(DEPOT, { lat: 51.5074, lng: -0.1278 }) / 1000).toBeCloseTo(9.9, 0);
  });

  it('adds road factor, urban speed and parking time', () => {
    const leg = estimateLeg(DEPOT, { lat: 51.5074, lng: -0.1278 });
    expect(leg.meters).toBeGreaterThan(13_000);
    expect(leg.seconds / 60).toBeGreaterThan(25);
    expect(estimateLeg(DEPOT, DEPOT)).toEqual({ meters: 0, seconds: 0 });
  });

  it('drives long legs at main-road speeds, not town speed', () => {
    // London → Birmingham: ~160 km straight line, ~2h 15m by road for a van.
    const minutes = estimateLeg(DEPOT, { lat: 52.4862, lng: -1.8904 }).seconds / 60;
    expect(minutes).toBeGreaterThan(120);
    expect(minutes).toBeLessThan(220);
  });
});

describe('simulate', () => {
  it('waits for a window to open and rejects a missed window', () => {
    const s = { ...ring[0]!, window: { start: at('11:00'), end: at('12:00') } };
    const ok = simulate(vehicle('v'), [s]);
    expect(ok.ok).toBe(true);
    expect(ok.visits[0]!.start).toEqual(at('11:00'));
    expect(simulate(vehicle('v', { startTime: at('11:55') }), [s]).reason).toBe('time_window');
  });

  it('rejects overload and overtime', () => {
    expect(simulate(vehicle('v', { capacity: 3 }), [ring[0]!]).reason).toBe('capacity');
    expect(simulate(vehicle('v', { endTime: at('08:20') }), [ring[0]!, ring[1]!]).reason).toBe('working_hours');
  });
});

describe('optimiseLocally', () => {
  it('plans every stop exactly once when capacity allows', () => {
    const result = optimiseLocally({ shipments: ring, vehicles: [vehicle('a'), vehicle('b')] });
    const planned = result.routes.flatMap((r) => r.visits.map((v) => v.orderId));
    expect(result.skipped).toEqual([]);
    expect(planned.sort()).toEqual(ring.map((s) => s.orderId).sort());
    expect(result.engine).toBe('estimate');
  });

  it('respects van capacity by splitting across vans', () => {
    const result = optimiseLocally({ shipments: ring, vehicles: [vehicle('a', { capacity: 24 }), vehicle('b', { capacity: 24 })] });
    expect(result.skipped).toEqual([]);
    for (const r of result.routes) expect(r.visits.length * 4).toBeLessThanOrEqual(24);
    expect(result.routes).toHaveLength(2);
  });

  it('skips with a reason what cannot fit', () => {
    const huge = { ...ring[0]!, orderId: 'huge', demand: 99 };
    const tooLate = { ...ring[1]!, orderId: 'late', window: { start: at('06:00'), end: at('07:00') } };
    const result = optimiseLocally({ shipments: [huge, tooLate, ring[2]!], vehicles: [vehicle('a')] });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { orderId: 'huge', reason: 'capacity' },
        { orderId: 'late', reason: 'time_window' },
      ]),
    );
    expect(result.routes[0]!.visits.map((v) => v.orderId)).toEqual(['o2']);
  });

  it('honours delivery windows in the visit order', () => {
    const morning = { ...ring[3]!, window: { start: at('08:00'), end: at('10:00') } };
    const afternoon = { ...ring[9]!, window: { start: at('14:00'), end: at('16:00') } };
    const result = optimiseLocally({ shipments: [afternoon, morning, ring[0]!, ring[6]!], vehicles: [vehicle('a')] });
    const visits = result.routes[0]!.visits;
    const idx = (id: string) => visits.findIndex((v) => v.orderId === id);
    expect(idx(morning.orderId)).toBeLessThan(idx(afternoon.orderId));
    const pm = visits[idx(afternoon.orderId)]!;
    expect(pm.start >= at('14:00') && pm.start <= at('16:00')).toBe(true);
  });

  it('reports no_vehicle when nobody is driving', () => {
    expect(optimiseLocally({ shipments: [ring[0]!], vehicles: [] }).skipped).toEqual([{ orderId: 'o0', reason: 'no_vehicle' }]);
  });

  it('beats a naive order on distance', () => {
    // Every 5th stop round the ring: criss-crosses the area the way an unplanned list does.
    const scrambled = ring.map((_, i) => ring[(i * 5) % ring.length]!);
    const naive = simulate(vehicle('a', { capacity: null }), scrambled);
    const optimised = optimiseLocally({ shipments: ring, vehicles: [vehicle('a', { capacity: null })] });
    expect(optimised.routes[0]!.distanceMeters).toBeLessThan(naive.meters);
  });

  it('never returns a worse plan than the one it starts from', () => {
    const v = vehicle('a', { capacity: null });
    const current = ring.map((s) => s.orderId);
    const before = simulate(v, ring);
    const result = optimiseLocally({ shipments: ring, vehicles: [v] }, { initial: [current] });
    const after = result.routes[0]!;
    expect(after.visits).toHaveLength(ring.length);
    expect(after.travelSeconds + after.distanceMeters / 1000).toBeLessThanOrEqual(before.seconds + before.meters / 1000);
  });

  it('handles 150 stops / 8 vans quickly (PRD §10)', () => {
    const many: ShipmentSpec[] = Array.from({ length: 150 }, (_, i) => ({
      orderId: `m${i}`,
      location: { lat: DEPOT.lat + Math.sin(i * 7.3) * 0.08, lng: DEPOT.lng + Math.cos(i * 3.1) * 0.15 },
      serviceSeconds: 600,
      demand: 2,
      window: null,
    }));
    const t0 = Date.now();
    const result = optimiseLocally({ shipments: many, vehicles: Array.from({ length: 8 }, (_, i) => vehicle(`v${i}`)) });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(result.routes.reduce((n, r) => n + r.visits.length, 0) + result.skipped.length).toBe(150);
  }, 40_000);
});
