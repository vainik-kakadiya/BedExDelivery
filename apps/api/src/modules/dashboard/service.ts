import { type Db, deliveryAttempts, depots, driverLocations, drivers, orders, routeStops, routes, users, vans } from '@bedex/db';
import type { ActionQueueItem, DashboardLive, DashboardRouteRow, DashboardSummary, OrderStatus } from '@bedex/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
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

/** DSH-03: last known driver positions and stop pins for the day. */
export async function getDashboardLive(db: Db, date: string): Promise<DashboardLive> {
  const [driverRows, stopRows, depotRows] = await Promise.all([
    db
      .selectDistinctOn([driverLocations.driverId], {
        driverId: driverLocations.driverId,
        name: users.name,
        routeId: driverLocations.routeId,
        routeName: routes.name,
        lat: driverLocations.lat,
        lng: driverLocations.lng,
        recordedAt: driverLocations.recordedAt,
      })
      .from(driverLocations)
      .innerJoin(drivers, eq(drivers.id, driverLocations.driverId))
      .innerJoin(users, eq(users.id, drivers.userId))
      .leftJoin(routes, eq(routes.id, driverLocations.routeId))
      .where(onLondonDates(driverLocations.recordedAt, date))
      .orderBy(driverLocations.driverId, desc(driverLocations.recordedAt)),
    db
      .select({
        stopId: routeStops.id,
        routeId: routes.id,
        routeName: routes.name,
        sequence: routeStops.sequence,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        status: orders.status,
        lat: orders.lat,
        lng: orders.lng,
      })
      .from(routeStops)
      .innerJoin(routes, eq(routes.id, routeStops.routeId))
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .where(and(eq(routes.date, date), isNotNull(orders.lat), isNotNull(orders.lng)))
      .orderBy(asc(routes.name), asc(routeStops.sequence)),
    db
      .select({ id: depots.id, name: depots.name, lat: depots.lat, lng: depots.lng })
      .from(depots)
      .where(eq(depots.active, true)),
  ]);

  return {
    date,
    drivers: driverRows.map((d) => ({ ...d, recordedAt: d.recordedAt.toISOString() })),
    // isNotNull above guarantees coordinates; the filter narrows the type.
    stops: stopRows.flatMap((s) => (s.lat !== null && s.lng !== null ? [{ ...s, lat: s.lat, lng: s.lng }] : [])),
    depots: depotRows,
  };
}
