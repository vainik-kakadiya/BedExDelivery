import type { RouteEndType, RouteWarning } from '@bedex/shared';
import type { Leg, TimeWindow } from './engine';

export interface ScheduleStop {
  orderId: string;
  serviceSeconds: number;
  window: TimeWindow | null;
}

export interface ScheduledStop {
  orderId: string;
  arrival: Date;
  /** Service start = the customer-facing ETA (waits for the window to open). */
  start: Date;
  departure: Date;
  windowOk: boolean;
}

export interface Schedule {
  /** When the van leaves (may be after the driver's start; see departureTime). */
  start: Date;
  stops: ScheduledStop[];
  end: Date;
  meters: number;
  seconds: number;
}

/**
 * RTE-07: ETAs for a fixed stop order. Unlike the optimiser this never rejects
 * a stop; late arrivals are flagged (windowOk = false) for RTE-08 warnings.
 * `legs` = depot→stop1, stop1→stop2, …, plus lastStop→end when there is an end.
 */
export function computeSchedule(earliestStart: Date, stops: ScheduleStop[], legs: Leg[]): Schedule {
  const start = new Date(departureTime(earliestStart.getTime(), stops[0]?.window ?? null, legs[0]?.seconds ?? 0));
  let t = start.getTime();
  let meters = 0;
  let seconds = 0;
  const out: ScheduledStop[] = stops.map((s, i) => {
    const leg = legs[i] ?? { meters: 0, seconds: 0 };
    meters += leg.meters;
    seconds += leg.seconds;
    t += leg.seconds * 1000;
    const arrival = t;
    const begin = s.window ? Math.max(arrival, s.window.start.getTime()) : arrival;
    t = begin + s.serviceSeconds * 1000;
    return {
      orderId: s.orderId,
      arrival: new Date(arrival),
      start: new Date(begin),
      departure: new Date(t),
      windowOk: !s.window || begin <= s.window.end.getTime(),
    };
  });
  for (const leg of legs.slice(stops.length)) {
    meters += leg.meters;
    seconds += leg.seconds;
    t += leg.seconds * 1000;
  }
  return { start, stops: out, end: new Date(t), meters, seconds };
}

/**
 * Leave the depot no earlier than needed: if the first stop's window opens after
 * the van would arrive, start later instead of waiting on the customer's street.
 */
export function departureTime(earliest: number, firstWindow: TimeWindow | null, firstLegSeconds: number): number {
  if (!firstWindow) return earliest;
  return Math.max(earliest, firstWindow.start.getTime() - firstLegSeconds * 1000);
}

export interface WarningInput {
  status: string;
  driverId: string | null;
  vanId: string | null;
  endType: RouteEndType;
  hasHomeLocation: boolean;
  capacityUnits: number | null;
  capacityKg: number | null;
  capacityM3: number | null;
  loadUnits: number;
  loadKg: number;
  loadM3: number;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  workEnd: Date | null;
  maxHours: number | null;
  stops: { orderId: string; orderNumber: string; etaWindowOk: boolean | null; hasGeocode: boolean }[];
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-GB');
const list = (xs: string[]) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} +${xs.length - 3} more`);

/** Each capacity the load exceeds, e.g. "14/12 units". Empty when it fits (or there is no van). */
export function overCapacity(
  van: { capacityUnits: number | null; capacityKg: number | null; capacityM3: number | null } | null | undefined,
  load: { units: number; kg: number; m3: number },
): string[] {
  if (!van) return [];
  const over: string[] = [];
  // A hair of tolerance so 0.1 + 0.2-style float sums don't block a full van.
  const exceeds = (value: number, cap: number | null) => cap !== null && value > cap + 1e-6;
  if (exceeds(load.units, van.capacityUnits)) over.push(`${fmt(load.units)}/${fmt(van.capacityUnits!)} units`);
  if (exceeds(load.kg, van.capacityKg)) over.push(`${fmt(load.kg)}/${fmt(van.capacityKg!)} kg`);
  if (exceeds(load.m3, van.capacityM3)) over.push(`${fmt(load.m3)}/${fmt(van.capacityM3!)} m³`);
  return over;
}

/** RTE-08 warnings for one route. */
export function routeWarnings(r: WarningInput): RouteWarning[] {
  const w: RouteWarning[] = [];
  if (r.stops.length === 0) w.push({ code: 'empty', message: 'No stops on this route' });
  if (!r.driverId) w.push({ code: 'no_driver', message: 'No driver assigned' });
  if (!r.vanId) w.push({ code: 'no_van', message: 'No van assigned' });

  const over = overCapacity(
    r.vanId ? { capacityUnits: r.capacityUnits, capacityKg: r.capacityKg, capacityM3: r.capacityM3 } : null,
    { units: r.loadUnits, kg: r.loadKg, m3: r.loadM3 },
  );
  if (over.length) {
    w.push({ code: 'over_capacity', message: `Over van capacity: ${over.join(', ')}${r.status === 'draft' ? ' – it can’t be released like this' : ''}` });
  }

  const late = r.stops.filter((s) => s.etaWindowOk === false);
  if (late.length) {
    w.push({
      code: 'outside_window',
      message: `ETA outside the delivery window: ${list(late.map((s) => s.orderNumber))}`,
      orderIds: late.map((s) => s.orderId),
    });
  }

  if (r.plannedEnd && r.workEnd && r.plannedEnd > r.workEnd) {
    const mins = Math.round((r.plannedEnd.getTime() - r.workEnd.getTime()) / 60_000);
    w.push({ code: 'over_hours', message: `Finishes ${mins} min after the driver's working day ends` });
  } else if (r.plannedStart && r.plannedEnd && r.maxHours !== null) {
    const hours = (r.plannedEnd.getTime() - r.plannedStart.getTime()) / 3_600_000;
    if (hours > r.maxHours) w.push({ code: 'over_hours', message: `Route takes ${fmt(hours)} h; driver maximum is ${fmt(r.maxHours)} h` });
  }

  const noGeo = r.stops.filter((s) => !s.hasGeocode);
  if (noGeo.length) {
    w.push({
      code: 'missing_geocode',
      message: `No map location, so ETAs are missing: ${list(noGeo.map((s) => s.orderNumber))}`,
      orderIds: noGeo.map((s) => s.orderId),
    });
  }
  if (r.endType === 'driver_home' && !r.hasHomeLocation) {
    w.push({ code: 'no_home_location', message: "Ends at the driver's home, but no home location is set – using the depot" });
  }
  return w;
}
