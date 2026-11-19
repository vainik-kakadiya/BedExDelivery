/**
 * Offline routing used when no Google credentials are configured.
 * Travel = straight-line distance × road factor, at a speed that rises with the
 * length of the leg (town streets → A-roads → motorways), so results are
 * labelled "estimated" in the UI. The optimiser is a cheapest-insertion
 * construction followed by relocate, exchange and 2-opt improvement, honouring
 * van capacity, delivery windows and drivers' working hours.
 */
import type {
  LatLng,
  Leg,
  OptimiseResult,
  PlannedRoute,
  PlannedVisit,
  PlanningModel,
  ShipmentSpec,
  SkipReason,
  VehicleSpec,
} from './types';

const EARTH_RADIUS_M = 6_371_000;
/** Roads are longer than straight lines; ~1.35 is typical for UK urban driving. */
const ROAD_FACTOR = 1.35;
/**
 * Van speed by distance band, including junctions. One flat urban speed made a
 * 60-mile leg take 4+ hours, so long routes "didn't fit" a working day that they
 * fit easily on real roads. The first few km of any leg are town streets; longer
 * legs use A-roads and then motorways / dual carriageways.
 */
const SPEED_BANDS: { untilMeters: number; mps: number }[] = [
  { untilMeters: 5_000, mps: 20 / 3.6 },
  { untilMeters: 25_000, mps: 40 / 3.6 },
  { untilMeters: Infinity, mps: 75 / 3.6 },
];
/** Parking / manoeuvring at each stop. */
const PARKING_SECONDS = 120;

function driveSeconds(meters: number): number {
  let seconds = 0;
  let from = 0;
  for (const band of SPEED_BANDS) {
    const part = Math.min(meters, band.untilMeters) - from;
    if (part <= 0) break;
    seconds += part / band.mps;
    from = band.untilMeters;
  }
  return seconds;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function estimateLeg(a: LatLng, b: LatLng): Leg {
  const meters = haversineMeters(a, b) * ROAD_FACTOR;
  if (meters < 50) return { meters, seconds: 0 };
  return { meters, seconds: Math.round(driveSeconds(meters) + PARKING_SECONDS) };
}

// ---------- simulation ----------

interface Simulation {
  ok: boolean;
  reason?: SkipReason;
  visits: PlannedVisit[];
  startTime: Date;
  endTime: Date;
  meters: number;
  seconds: number;
}

/** Drive a vehicle through `seq` in order, checking every constraint. */
export function simulate(vehicle: VehicleSpec, seq: ShipmentSpec[], leg: (a: LatLng, b: LatLng) => Leg = estimateLeg): Simulation {
  const load = seq.reduce((n, s) => n + s.demand, 0);
  const fail = (reason: SkipReason): Simulation => ({
    ok: false,
    reason,
    visits: [],
    startTime: vehicle.startTime,
    endTime: vehicle.startTime,
    meters: 0,
    seconds: 0,
  });
  if (vehicle.capacity !== null && load > vehicle.capacity + 1e-9) return fail('capacity');

  // Leave late rather than wait at the first stop (mirrors departureTime in schedule.ts).
  const first = seq[0];
  const firstLeg = first ? leg(vehicle.start, first.location).seconds : 0;
  const departAt = first?.window ? Math.max(vehicle.startTime.getTime(), first.window.start.getTime() - firstLeg * 1000) : vehicle.startTime.getTime();
  let t = departAt;
  let pos = vehicle.start;
  let meters = 0;
  let seconds = 0;
  const visits: PlannedVisit[] = [];
  for (const s of seq) {
    const l = leg(pos, s.location);
    meters += l.meters;
    seconds += l.seconds;
    t += l.seconds * 1000;
    const arrival = t;
    const start = s.window ? Math.max(arrival, s.window.start.getTime()) : arrival;
    if (s.window && start > s.window.end.getTime()) return fail('time_window');
    t = start + s.serviceSeconds * 1000;
    visits.push({ orderId: s.orderId, arrival: new Date(arrival), start: new Date(start), departure: new Date(t) });
    pos = s.location;
  }
  if (vehicle.end) {
    const l = leg(pos, vehicle.end);
    meters += l.meters;
    seconds += l.seconds;
    t += l.seconds * 1000;
  }
  if (t > vehicle.endTime.getTime()) return fail('working_hours');
  if (vehicle.maxDurationSeconds !== null && t - departAt > vehicle.maxDurationSeconds * 1000) {
    return fail('working_hours');
  }
  return { ok: true, visits, startTime: new Date(departAt), endTime: new Date(t), meters, seconds };
}

/** Cost minimised by the optimiser: driving time, with distance as a tie-breaker. */
const cost = (sim: Simulation) => sim.seconds + sim.meters / 1000;

// ---------- optimiser ----------

export interface LocalOptions {
  /**
   * Start from these stop orders (order ids, one list per vehicle) instead of an
   * empty plan. Improvement only ever accepts cheaper plans, so the result is
   * never worse than the starting plan. Ignored for a vehicle whose list breaks
   * a rule (capacity, window, hours).
   */
  initial?: string[][];
}

export function optimiseLocally(model: PlanningModel, options: LocalOptions = {}): OptimiseResult {
  const { vehicles } = model;
  const byId = new Map(model.shipments.map((s) => [s.orderId, s]));
  const routes: ShipmentSpec[][] = vehicles.map((vehicle, v) => {
    const seed = (options.initial?.[v] ?? []).map((id) => byId.get(id)).filter((s): s is ShipmentSpec => !!s);
    return seed.length && simulate(vehicle, seed).ok ? seed : [];
  });
  const costs: number[] = vehicles.map((v, i) => cost(simulate(v, routes[i]!)));
  const skipped: OptimiseResult['skipped'] = [];
  const seeded = new Set(routes.flat());

  const maxCapacity = vehicles.some((v) => v.capacity === null) ? Infinity : Math.max(0, ...vehicles.map((v) => v.capacity ?? 0));
  // Tightest windows first gives cheapest insertion a better start on ties.
  let pending = model.shipments.filter((s) => !seeded.has(s)).sort(
    (a, b) => (a.window?.end.getTime() ?? Infinity) - (b.window?.end.getTime() ?? Infinity) || a.orderId.localeCompare(b.orderId),
  );
  if (vehicles.length === 0) {
    return { routes: [], skipped: pending.map((s) => ({ orderId: s.orderId, reason: 'no_vehicle' })), engine: 'estimate' };
  }
  pending = pending.filter((s) => {
    if (s.demand > maxCapacity) {
      skipped.push({ orderId: s.orderId, reason: 'capacity' });
      return false;
    }
    return true;
  });

  // --- construction: repeatedly insert the shipment whose best insertion is cheapest ---
  while (pending.length) {
    let best: { s: ShipmentSpec; v: number; pos: number; delta: number } | null = null;
    const infeasible: { s: ShipmentSpec; reason: SkipReason }[] = [];

    for (const s of pending) {
      let bestForS: { v: number; pos: number; delta: number } | null = null;
      const reasons = new Map<SkipReason, number>();
      vehicles.forEach((vehicle, v) => {
        const route = routes[v]!;
        for (let pos = 0; pos <= route.length; pos++) {
          const sim = simulate(vehicle, [...route.slice(0, pos), s, ...route.slice(pos)]);
          if (!sim.ok) {
            reasons.set(sim.reason!, (reasons.get(sim.reason!) ?? 0) + 1);
            continue;
          }
          const delta = cost(sim) - costs[v]!;
          if (!bestForS || delta < bestForS.delta) bestForS = { v, pos, delta };
        }
      });
      if (!bestForS) {
        const reason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
        infeasible.push({ s, reason });
      } else if (!best || (bestForS as { delta: number }).delta < best.delta) {
        best = { s, ...(bestForS as { v: number; pos: number; delta: number }) };
      }
    }

    for (const { s, reason } of infeasible) skipped.push({ orderId: s.orderId, reason });
    pending = pending.filter((s) => !infeasible.some((i) => i.s === s));
    if (!best) break;

    const route = routes[best.v]!;
    route.splice(best.pos, 0, best.s);
    costs[best.v] = cost(simulate(vehicles[best.v]!, route));
    pending = pending.filter((s) => s !== best!.s);
  }

  improve(vehicles, routes, costs);

  const planned: PlannedRoute[] = [];
  vehicles.forEach((vehicle, v) => {
    const route = routes[v]!;
    if (route.length === 0) return;
    const sim = simulate(vehicle, route);
    planned.push({
      vehicleKey: vehicle.key,
      visits: sim.visits,
      startTime: sim.startTime,
      endTime: sim.endTime,
      distanceMeters: sim.meters,
      travelSeconds: sim.seconds,
      polyline: null,
    });
  });
  return { routes: planned, skipped, engine: 'estimate' };
}

/** Relocate single stops (within or across routes) and 2-opt each route until nothing improves. */
function improve(vehicles: VehicleSpec[], routes: ShipmentSpec[][], costs: number[], maxPasses = 8): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    // Relocate
    for (let from = 0; from < routes.length; from++) {
      for (let i = 0; i < routes[from]!.length; i++) {
        const s = routes[from]![i]!;
        const without = routes[from]!.filter((_, k) => k !== i);
        const fromSim = simulate(vehicles[from]!, without);
        if (!fromSim.ok) continue;
        const saving = costs[from]! - cost(fromSim);
        let best: { to: number; pos: number; gain: number } | null = null;
        for (let to = 0; to < routes.length; to++) {
          const base = to === from ? without : routes[to]!;
          const baseCost = to === from ? cost(fromSim) : costs[to]!;
          for (let pos = 0; pos <= base.length; pos++) {
            if (to === from && pos === i) continue;
            const sim = simulate(vehicles[to]!, [...base.slice(0, pos), s, ...base.slice(pos)]);
            if (!sim.ok) continue;
            const gain = to === from ? costs[from]! - cost(sim) : saving - (cost(sim) - baseCost);
            if (gain > 1 && (!best || gain > best.gain)) best = { to, pos, gain };
          }
        }
        if (best) {
          routes[from] = without;
          routes[best.to]!.splice(best.pos, 0, s);
          costs[from] = cost(simulate(vehicles[from]!, routes[from]!));
          costs[best.to] = cost(simulate(vehicles[best.to]!, routes[best.to]!));
          improved = true;
          i = -1; // route changed; rescan it
        }
      }
    }

    // Exchange: swap two stops on different routes (relocate can't do this in one
    // step when both vans are full or both moves are only good together).
    for (let a = 0; a < routes.length; a++) {
      for (let b = a + 1; b < routes.length; b++) {
        for (let i = 0; i < routes[a]!.length; i++) {
          for (let j = 0; j < routes[b]!.length; j++) {
            const ra = [...routes[a]!];
            const rb = [...routes[b]!];
            [ra[i], rb[j]] = [rb[j]!, ra[i]!];
            const simA = simulate(vehicles[a]!, ra);
            if (!simA.ok) continue;
            const simB = simulate(vehicles[b]!, rb);
            if (!simB.ok) continue;
            if (cost(simA) + cost(simB) < costs[a]! + costs[b]! - 1) {
              routes[a] = ra;
              routes[b] = rb;
              costs[a] = cost(simA);
              costs[b] = cost(simB);
              improved = true;
            }
          }
        }
      }
    }

    // 2-opt
    for (let v = 0; v < routes.length; v++) {
      const route = routes[v]!;
      for (let i = 0; i < route.length - 1; i++) {
        for (let j = i + 1; j < route.length; j++) {
          const candidate = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
          const sim = simulate(vehicles[v]!, candidate);
          if (sim.ok && cost(sim) < costs[v]! - 1) {
            routes[v] = candidate;
            costs[v] = cost(sim);
            route.splice(0, route.length, ...candidate);
            improved = true;
          }
        }
      }
    }

    if (!improved) return;
  }
}
