import { type Db, deliveryAttempts, depots, driverLocations, drivers, orders, routeStops, routes, users, vans } from '@bedex/db';
import type { ActionQueueItem, DashboardLive, DashboardRouteRow, DashboardSummary, LiveRoute, OrderStatus, RouteEndType, RouteStatus } from '@bedex/shared';
import { and, asc, count, desc, eq, inArray, max } from 'drizzle-orm';
import { onLondonDates } from '../../lib/time';

const AWAITING_ALLOCATION: OrderStatus[] = ['awaiting_scheduling', 'in_warehouse', 'rescheduled'];
const NEEDS_DECISION: OrderStatus[] = ['failed', 'partially_delivered'];
const ACTION_QUEUE_LIMIT = 200;

interface StopTiming {
  eta: Date | null;
  completedAt: Date | null;
}

/**
 * DSH-02 "current ETA drift", in minutes (+ late, − early):
 * the larger of how late the most recently completed stop was against its ETA,
 * and how overdue the next outstanding stop already is. Null with no timing data.
 * Becomes more precise once ETAs are recalculated live via the Routes API.
 */
export function etaDriftMinutes(stops: StopTiming[], now: Date): number | null {
  const minutes = (ms: number) => Math.round(ms / 60_000);

  let lastDone: StopTiming | undefined;
  let nextDue: StopTiming | undefined;
  for (const s of stops) {
    if (!s.eta) continue;
    if (s.completedAt) {
      if (!lastDone?.completedAt || s.completedAt > lastDone.completedAt) lastDone = s;
    } else if (!nextDue?.eta || s.eta < nextDue.eta) {
      nextDue = s;
    }
  }

  let drift: number | null =
    lastDone?.completedAt && lastDone.eta ? minutes(lastDone.completedAt.getTime() - lastDone.eta.getTime()) : null;
  if (nextDue?.eta && now > nextDue.eta) {
    const overdue = minutes(now.getTime() - nextDue.eta.getTime());
    drift = drift === null ? overdue : Math.max(drift, overdue);
  }
  return drift;
}

const maxDate = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((latest, d) => (d && (!latest || d > latest) ? d : latest), null);

export async function getDashboardSummary(db: Db, date: string, now = new Date()): Promise<DashboardSummary> {
  const [routeRows, [awaiting], [needsDecision], attemptCounts, actionQueue] = await Promise.all([
    db
      .select({
        id: routes.id,
        name: routes.name,
        status: routes.status,
        startedAt: routes.startedAt,
        releasedAt: routes.releasedAt,
        driverId: routes.driverId,
        driverName: users.name,
        vanName: vans.name,
        vanRegistration: vans.registration,
      })
      .from(routes)
      .leftJoin(drivers, eq(drivers.id, routes.driverId))
      .leftJoin(users, eq(users.id, drivers.userId))
      .leftJoin(vans, eq(vans.id, routes.vanId))
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name)),
    db.select({ n: count() }).from(orders).where(inArray(orders.status, AWAITING_ALLOCATION)),
    db.select({ n: count() }).from(orders).where(inArray(orders.status, NEEDS_DECISION)),
    db
      .select({ outcome: deliveryAttempts.outcome, n: count() })
      .from(deliveryAttempts)
      .innerJoin(routes, eq(routes.id, deliveryAttempts.routeId))
      .where(eq(routes.date, date))
      .groupBy(deliveryAttempts.outcome),
    getActionQueue(db),
  ]);

  const routeIds = routeRows.map((r) => r.id);
  const [stops, lastPings] = routeIds.length
    ? await Promise.all([
        db
          .select({ routeId: routeStops.routeId, eta: routeStops.eta, completedAt: routeStops.completedAt })
          .from(routeStops)
          .where(inArray(routeStops.routeId, routeIds)),
        db
          .select({ routeId: driverLocations.routeId, at: max(driverLocations.recordedAt) })
          .from(driverLocations)
          .where(inArray(driverLocations.routeId, routeIds))
          .groupBy(driverLocations.routeId),
      ])
    : [[], []];

  const routesOut: DashboardRouteRow[] = routeRows.map((r) => {
    const own = stops.filter((s) => s.routeId === r.id);
    const completed = own.filter((s) => s.completedAt);
    const lastPing = lastPings.find((p) => p.routeId === r.id)?.at ?? null;
    const lastUpdate = maxDate(r.releasedAt, r.startedAt, lastPing, ...completed.map((s) => s.completedAt));
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      driverId: r.driverId,
      driverName: r.driverName,
      vanName: r.vanName,
      vanRegistration: r.vanRegistration,
      stopsTotal: own.length,
      stopsCompleted: completed.length,
      etaDriftMinutes: r.status === 'draft' ? null : etaDriftMinutes(own, now),
      lastUpdateAt: lastUpdate?.toISOString() ?? null,
    };
  });

  const stopsCompleted = routesOut.reduce((n, r) => n + r.stopsCompleted, 0);
  const stopsTotal = routesOut.reduce((n, r) => n + r.stopsTotal, 0);
  const attempts = (o: string) => attemptCounts.find((a) => a.outcome === o)?.n ?? 0;

  return {
    date,
    cards: {
      awaitingAllocation: awaiting?.n ?? 0,
      routesToday: routesOut.length,
      stopsCompleted,
      stopsOutstanding: stopsTotal - stopsCompleted,
      failedToday: attempts('failed'),
      partialToday: attempts('partial'),
      needsDecision: needsDecision?.n ?? 0,
    },
    routes: routesOut,
    actionQueue,
  };
}

/** DSH-04: failed + partially delivered orders, oldest first, with their latest attempt. */
async function getActionQueue(db: Db): Promise<ActionQueueItem[]> {
  const queue = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      town: orders.town,
      postcode: orders.postcode,
      status: orders.status,
    })
    .from(orders)
    .where(inArray(orders.status, NEEDS_DECISION))
    .orderBy(asc(orders.updatedAt))
    .limit(ACTION_QUEUE_LIMIT);
  if (queue.length === 0) return [];

  const latest = await db
    .selectDistinctOn([deliveryAttempts.orderId], {
      orderId: deliveryAttempts.orderId,
      attemptNo: deliveryAttempts.attemptNo,
      outcome: deliveryAttempts.outcome,
      failureReason: deliveryAttempts.failureReason,
      notes: deliveryAttempts.notes,
      occurredAt: deliveryAttempts.occurredAt,
      driverName: users.name,
    })
    .from(deliveryAttempts)
    .leftJoin(drivers, eq(drivers.id, deliveryAttempts.driverId))
    .leftJoin(users, eq(users.id, drivers.userId))
    .where(
      inArray(
        deliveryAttempts.orderId,
        queue.map((q) => q.orderId),
      ),
    )
    .orderBy(deliveryAttempts.orderId, desc(deliveryAttempts.attemptNo));

  return queue.map((q) => {
    const a = latest.find((l) => l.orderId === q.orderId);
    return {
      ...q,
      attemptNo: a?.attemptNo ?? null,
      outcome: a?.outcome ?? null,
      failureReason: a?.failureReason ?? null,
      attemptNotes: a?.notes ?? null,
      attemptAt: a?.occurredAt.toISOString() ?? null,
      driverName: a?.driverName ?? null,
    };
  });
}

/** Order statuses that mean the driver has finished with a stop, whatever the outcome. */
const FINISHED: readonly OrderStatus[] = ['delivered', 'partially_delivered', 'failed', 'returned_to_warehouse', 'cancelled'];

interface LiveStopRow {
  stopId: string;
  routeId: string;
  sequence: number;
  postcode: string;
  customerName: string;
  status: OrderStatus;
  eta: Date | null;
  completedAt: Date | null;
  lat: number | null;
  lng: number | null;
}

interface LiveRouteRow {
  id: string;
  name: string;
  status: RouteStatus;
  driverId: string | null;
  driverName: string | null;
  vanName: string | null;
  vanRegistration: string | null;
  depotId: string;
  endType: RouteEndType;
  polyline: string | null;
  plannedEnd: Date | null;
}

interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: Date;
}

const isDone = (s: LiveStopRow) => s.completedAt !== null || FINISHED.includes(s.status);
const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * DSH-03: a route's progress for the tracking map. `stops` are in sequence order.
 * The van is shown at its latest GPS fix, or at the last finished stop when that
 * is newer (the driver app only sends GPS while it is open on screen).
 */
export function buildLiveRoute(route: LiveRouteRow, stops: LiveStopRow[], gps: GpsFix | null): LiveRoute {
  const done = stops.filter(isDone).sort((a, b) => (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0) || a.sequence - b.sequence);
  const todo = stops.filter((s) => !isDone(s));
  const next = todo[0] ?? null;
  const lastStop = todo.at(-1) ?? stops.at(-1) ?? null;

  const lastVisited = [...done].reverse().find((s) => s.completedAt && s.lat !== null && s.lng !== null);
  let position: LiveRoute['position'] = null;
  if (route.status !== 'draft') {
    if (gps && (!lastVisited?.completedAt || gps.recordedAt >= lastVisited.completedAt)) {
      position = { lat: gps.lat, lng: gps.lng, at: gps.recordedAt.toISOString(), source: 'gps', accuracy: gps.accuracy };
    } else if (lastVisited?.completedAt && lastVisited.lat !== null && lastVisited.lng !== null) {
      position = { lat: lastVisited.lat, lng: lastVisited.lng, at: lastVisited.completedAt.toISOString(), source: 'stop', accuracy: null };
    }
  }

  return {
    routeId: route.id,
    name: route.name,
    status: route.status,
    driverId: route.driverId,
    driverName: route.driverName,
    vanName: route.vanName,
    vanRegistration: route.vanRegistration,
    depotId: route.depotId,
    endType: route.endType,
    polyline: route.polyline,
    stopsTotal: stops.length,
    stopsCompleted: done.length,
    nextStop: next && { stopId: next.stopId, sequence: next.sequence, postcode: next.postcode, customerName: next.customerName, eta: iso(next.eta) },
    lastStopEta: lastStop ? iso(todo.length ? lastStop.eta : (lastStop.completedAt ?? lastStop.eta)) : null,
    plannedEnd: iso(route.plannedEnd),
    done: done.map((s) => ({ stopId: s.stopId, sequence: s.sequence, postcode: s.postcode, status: s.status, completedAt: iso(s.completedAt) })),
    position,
  };
}

/** DSH-03: every route of the day with its stops, van position and progress. */
export async function getDashboardLive(db: Db, date: string): Promise<DashboardLive> {
  const [routeRows, stopRows, depotRows] = await Promise.all([
    db
      .select({
        id: routes.id,
        name: routes.name,
        status: routes.status,
        driverId: routes.driverId,
        driverName: users.name,
        vanName: vans.name,
        vanRegistration: vans.registration,
        depotId: routes.depotId,
        endType: routes.endType,
        polyline: routes.polyline,
        plannedEnd: routes.plannedEnd,
      })
      .from(routes)
      .leftJoin(drivers, eq(drivers.id, routes.driverId))
      .leftJoin(users, eq(users.id, drivers.userId))
      .leftJoin(vans, eq(vans.id, routes.vanId))
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name)),
    db
      .select({
        stopId: routeStops.id,
        routeId: routes.id,
        routeName: routes.name,
        sequence: routeStops.sequence,
        eta: routeStops.eta,
        completedAt: routeStops.completedAt,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        postcode: orders.postcode,
        status: orders.status,
        lat: orders.lat,
        lng: orders.lng,
      })
      .from(routeStops)
      .innerJoin(routes, eq(routes.id, routeStops.routeId))
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name), asc(routeStops.sequence)),
    db
      .select({ id: depots.id, name: depots.name, lat: depots.lat, lng: depots.lng })
      .from(depots)
      .where(eq(depots.active, true)),
  ]);

  const routeIds = routeRows.map((r) => r.id);
  const fixes = routeIds.length
    ? await db
        .selectDistinctOn([driverLocations.routeId], {
          routeId: driverLocations.routeId,
          lat: driverLocations.lat,
          lng: driverLocations.lng,
          accuracy: driverLocations.accuracy,
          recordedAt: driverLocations.recordedAt,
        })
        .from(driverLocations)
        .where(and(inArray(driverLocations.routeId, routeIds), onLondonDates(driverLocations.recordedAt, date)))
        .orderBy(driverLocations.routeId, desc(driverLocations.recordedAt))
    : [];

  const liveRoutes = routeRows.map((r) =>
    buildLiveRoute(
      r,
      stopRows.filter((s) => s.routeId === r.id),
      fixes.find((f) => f.routeId === r.id) ?? null,
    ),
  );

  return {
    date,
    // Kept for the plain list shown when the map can't load.
    drivers: liveRoutes.flatMap((r) =>
      r.position && r.driverId
        ? [{ driverId: r.driverId, name: r.driverName ?? r.name, routeId: r.routeId, routeName: r.name, lat: r.position.lat, lng: r.position.lng, recordedAt: r.position.at }]
        : [],
    ),
    stops: stopRows.flatMap((s) =>
      s.lat !== null && s.lng !== null
        ? [{ ...s, lat: s.lat, lng: s.lng, eta: iso(s.eta), completedAt: iso(s.completedAt) }]
        : [],
    ),
    routes: liveRoutes,
    depots: depotRows,
  };
}
