import { describe, expect, it } from 'vitest';
import { buildLiveRoute, etaDriftMinutes } from './service';

const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);

describe('etaDriftMinutes', () => {
  it('is null without timing data', () => {
    expect(etaDriftMinutes([], at('10:00'))).toBeNull();
    expect(etaDriftMinutes([{ eta: null, completedAt: null }], at('10:00'))).toBeNull();
  });

  it('is null before the first stop is due', () => {
    expect(etaDriftMinutes([{ eta: at('09:00'), completedAt: null }], at('08:30'))).toBeNull();
  });

  it('reports how late the most recent completed stop was', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('09:05') },
      { eta: at('09:30'), completedAt: at('09:42') },
      { eta: at('10:30'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('09:45'))).toBe(12);
  });

  it('reports running early as negative', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('08:52') },
      { eta: at('10:00'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('09:00'))).toBe(-8);
  });

  it('uses the overdue next stop when that is worse', () => {
    const stops = [
      { eta: at('09:00'), completedAt: at('09:02') },
      { eta: at('09:30'), completedAt: null },
    ];
    expect(etaDriftMinutes(stops, at('10:10'))).toBe(40);
  });

  it('flags a released route that has not started on time', () => {
    expect(etaDriftMinutes([{ eta: at('08:30'), completedAt: null }], at('09:00'))).toBe(30);
  });
});

describe('buildLiveRoute', () => {
  const route = {
    id: 'r1',
    name: 'Route A',
    status: 'in_progress' as const,
    driverId: 'd1',
    driverName: 'Alex Driver',
    vanName: 'Van 1',
    vanRegistration: 'AB12 CDE',
    depotId: 'dep',
    endType: 'depot' as const,
    polyline: null,
    plannedEnd: at('15:00'),
  };
  const stop = (sequence: number, postcode: string, eta: string, completedAt: string | null, status = completedAt ? 'delivered' : 'out_for_delivery') => ({
    stopId: `s${sequence}`,
    routeId: 'r1',
    sequence,
    postcode,
    customerName: `Customer ${sequence}`,
    status: status as 'delivered',
    eta: at(eta),
    completedAt: completedAt ? at(completedAt) : null,
    lat: 51 + sequence / 100,
    lng: -0.1,
  });
  const stops = [stop(1, 'ME15 6JY', '09:00', '09:05'), stop(2, 'ME14 1AA', '09:40', '09:50'), stop(3, 'ME16 8AB', '10:20', null), stop(4, 'ME17 2CD', '11:00', null)];

  it('reports progress, the next stop, the last stop ETA and the postcodes done', () => {
    const live = buildLiveRoute(route, stops, null);
    expect(live.stopsCompleted).toBe(2);
    expect(live.nextStop).toMatchObject({ sequence: 3, postcode: 'ME16 8AB' });
    expect(live.lastStopEta).toBe(at('11:00').toISOString());
    expect(live.done.map((d) => d.postcode)).toEqual(['ME15 6JY', 'ME14 1AA']);
  });

  it('places the van at its GPS fix when that is newer than the last delivery', () => {
    const live = buildLiveRoute(route, stops, { lat: 51.5, lng: 0.5, accuracy: 12, recordedAt: at('10:05') });
    expect(live.position).toMatchObject({ lat: 51.5, lng: 0.5, source: 'gps' });
  });

  it('falls back to the last finished stop when GPS is older or missing', () => {
    const live = buildLiveRoute(route, stops, { lat: 51.5, lng: 0.5, accuracy: 12, recordedAt: at('09:30') });
    expect(live.position).toMatchObject({ lat: 51.02, source: 'stop', at: at('09:50').toISOString() });
  });

  it('counts failed stops as done and has no position for drafts', () => {
    const failed = [stop(1, 'ME15 6JY', '09:00', null, 'failed'), stop(2, 'ME14 1AA', '09:40', null)];
    expect(buildLiveRoute(route, failed, null).nextStop?.sequence).toBe(2);
    expect(buildLiveRoute({ ...route, status: 'draft' }, stops, { lat: 1, lng: 1, accuracy: null, recordedAt: at('10:00') }).position).toBeNull();
  });

  it('uses the last completion time once every stop is done', () => {
    const allDone = [stop(1, 'ME15 6JY', '09:00', '09:05'), stop(2, 'ME14 1AA', '09:40', '09:58')];
    const live = buildLiveRoute({ ...route, status: 'completed' }, allDone, null);
    expect(live.nextStop).toBeNull();
    expect(live.lastStopEta).toBe(at('09:58').toISOString());
  });
});
