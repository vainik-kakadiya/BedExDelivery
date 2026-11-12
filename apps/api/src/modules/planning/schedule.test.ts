import { describe, expect, it } from 'vitest';
import { validateSettingsPatch } from '../settings/service';
import { type WarningInput, computeSchedule, routeWarnings } from './schedule';

const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);

describe('computeSchedule (RTE-07)', () => {
  it('chains legs and service times, waiting for windows', () => {
    const schedule = computeSchedule(
      at('08:00'),
      [
        { orderId: 'a', serviceSeconds: 600, window: null },
        { orderId: 'b', serviceSeconds: 600, window: { start: at('09:30'), end: at('10:00') } },
      ],
      [
        { meters: 5000, seconds: 1200 }, // depot → a: arrive 08:20, leave 08:30
        { meters: 3000, seconds: 900 }, // a → b: arrive 08:45, wait until 09:30
        { meters: 6000, seconds: 1500 }, // b → depot: leave 09:40, back 10:05
      ],
    );
    expect(schedule.stops[0]!.start).toEqual(at('08:20'));
    expect(schedule.stops[1]!.arrival).toEqual(at('08:45'));
    expect(schedule.stops[1]!.start).toEqual(at('09:30'));
    expect(schedule.stops[1]!.windowOk).toBe(true);
    expect(schedule.end).toEqual(at('10:05'));
    expect(schedule.meters).toBe(14000);
    expect(schedule.seconds).toBe(3600);
  });

  it('leaves the depot later instead of waiting at the first stop', () => {
    const schedule = computeSchedule(at('07:30'), [{ orderId: 'a', serviceSeconds: 600, window: { start: at('12:00'), end: at('14:00') } }], [
      { meters: 5000, seconds: 1800 },
    ]);
    expect(schedule.start).toEqual(at('11:30'));
    expect(schedule.stops[0]!.arrival).toEqual(at('12:00'));
  });

  it('flags a late stop instead of dropping it', () => {
    const schedule = computeSchedule(at('11:00'), [{ orderId: 'a', serviceSeconds: 600, window: { start: at('09:00'), end: at('10:00') } }], [
      { meters: 1000, seconds: 300 },
    ]);
    expect(schedule.stops[0]!.windowOk).toBe(false);
  });
});

const base: WarningInput = {
  status: 'draft',
  driverId: 'd',
  vanId: 'v',
  endType: 'depot',
  hasHomeLocation: false,
  capacityUnits: 40,
  capacityKg: null,
  capacityM3: null,
  loadUnits: 20,
  loadKg: 0,
  loadM3: 0,
  plannedStart: at('08:00'),
  plannedEnd: at('16:00'),
  workEnd: at('17:00'),
  maxHours: 10,
  stops: [{ orderId: 'o1', orderNumber: 'SO-1', etaWindowOk: true, hasGeocode: true }],
};
const codes = (input: Partial<WarningInput>) => routeWarnings({ ...base, ...input }).map((w) => w.code);

describe('routeWarnings (RTE-08)', () => {
  it('is quiet for a healthy route', () => {
    expect(codes({})).toEqual([]);
  });

  it('flags capacity, windows, hours, geocode and missing crew', () => {
    expect(codes({ loadUnits: 41 })).toContain('over_capacity');
    expect(codes({ capacityKg: 500, loadKg: 600 })).toContain('over_capacity');
    expect(codes({ stops: [{ ...base.stops[0]!, etaWindowOk: false }] })).toContain('outside_window');
    expect(codes({ plannedEnd: at('18:00') })).toContain('over_hours');
    expect(codes({ maxHours: 6 })).toContain('over_hours');
    expect(codes({ stops: [{ ...base.stops[0]!, hasGeocode: false }] })).toContain('missing_geocode');
    expect(codes({ driverId: null, vanId: null })).toEqual(expect.arrayContaining(['no_driver', 'no_van']));
    expect(codes({ stops: [] })).toContain('empty');
    expect(codes({ endType: 'driver_home' })).toContain('no_home_location');
  });

  it('names the late orders', () => {
    const [w] = routeWarnings({ ...base, stops: [{ orderId: 'x', orderNumber: 'SO-9', etaWindowOk: false, hasGeocode: true }] });
    expect(w!.message).toContain('SO-9');
    expect(w!.orderIds).toEqual(['x']);
  });
});

describe('validateSettingsPatch (RTE-02)', () => {
  it('accepts known keys with the right type', () => {
    expect(validateSettingsPatch({ 'routes.defaultEndType': 'last_stop', 'tracking.showDriverName': true })).toEqual({
      'routes.defaultEndType': 'last_stop',
      'tracking.showDriverName': true,
    });
  });

  it('rejects unknown keys, wrong types and bad values', () => {
    expect(() => validateSettingsPatch({ nope: 1 })).toThrow();
    expect(() => validateSettingsPatch({ 'tracking.showDriverName': 'yes' })).toThrow();
    expect(() => validateSettingsPatch({ 'routes.defaultEndType': 'moon' })).toThrow();
    expect(() => validateSettingsPatch({ 'retention.photoDays': -1 })).toThrow();
  });
});
