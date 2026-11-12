import {
  type Db,
  type DbOrTx,
  type Tx,
  auditLog,
  depots,
  drivers,
  orderEvents,
  orders,
  routeStops,
  routes,
  users,
  vans,
} from '@bedex/db';
import {
  ORDER_STATUS_META,
  type OptimiseRequest,
  type OptimiseSkipped,
  type OrderStatus,
  type PlannerOrder,
  type PlannerRoute,
  type PlannerState,
  type RouteEndType,
  type RouteStatus,
  type RouteUpdateInput,
  type RouteWarning,
  type RoutingEngineKind,
  londonToUtc,
  metresToMiles,
} from '@bedex/shared';
import { type SQL, and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import { lockOrder, transitionOrder } from '../orders/service';
import { getSettings } from '../settings/service';
import { type LatLng, type PlanningModel, type RoutingEngine, SKIP_REASON_TEXT, type TimeWindow } from './engine';
import { computeSchedule, routeWarnings } from './schedule';

export interface PlanningContext {
  db: Db;
  routing: RoutingEngine;
}

type RouteRow = typeof routes.$inferSelect;
type OrderPatchStatus = Extract<OrderStatus, 'awaiting_scheduling' | 'in_warehouse' | 'rescheduled'>;

/** Statuses an order can be planned from (RTE-01). */
const PLANNABLE: OrderPatchStatus[] = ['awaiting_scheduling', 'in_warehouse', 'rescheduled'];
/** Stops can change until the driver starts the route. */
const EDITABLE: RouteStatus[] = ['draft', 'released'];
const DEFAULT_WORK_START = '08:00';
const DEFAULT_WORK_END = '17:00';

// ---------- shared query pieces ----------

// Always table-qualified: in single-table selects Drizzle renders ${orders.id} as a
// bare "id", which inside these subqueries would resolve to order_items.id.
const ORDER_ID = sql.raw('"orders"."id"');
const loadUnits = sql<number>`coalesce((select sum(oi.units * oi.qty) from order_items oi where oi.order_id = ${ORDER_ID}), 0)`.mapWith(Number);
const loadKg = sql<number>`coalesce((select sum(coalesce(oi.weight_kg, 0) * oi.qty) from order_items oi where oi.order_id = ${ORDER_ID}), 0)`.mapWith(Number);
const loadM3 = sql<number>`coalesce((select sum(coalesce(oi.volume_m3, 0) * oi.qty) from order_items oi where oi.order_id = ${ORDER_ID}), 0)`.mapWith(Number);

const plannerOrderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  customerName: orders.customerName,
  addressLine1: orders.addressLine1,
  town: orders.town,
  postcode: orders.postcode,
  lat: orders.lat,
  lng: orders.lng,
  status: orders.status,
  scheduledDate: orders.scheduledDate,
  timeWindowStart: orders.timeWindowStart,
  timeWindowEnd: orders.timeWindowEnd,
  serviceMinutes: orders.serviceMinutes,
  extraMinutes: orders.extraMinutes,
  currentRouteId: orders.currentRouteId,
  loadUnits,
  loadKg,
  loadM3,
};
type PlannerOrderRow = { [K in keyof typeof plannerOrderColumns]: unknown } & {
  id: string;
  orderNumber: string;
  customerName: string;
  addressLine1: string;
  town: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  status: OrderStatus;
  scheduledDate: string | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  serviceMinutes: number;
  extraMinutes: number;
  currentRouteId: string | null;
  loadUnits: number;
  loadKg: number;
  loadM3: number;
};

function toPlannerOrder(o: PlannerOrderRow): PlannerOrder {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    addressLine1: o.addressLine1,
    town: o.town,
    postcode: o.postcode,
    lat: o.lat,
    lng: o.lng,
    status: o.status,
    scheduledDate: o.scheduledDate,
    timeWindowStart: o.timeWindowStart?.slice(0, 5) ?? null,
    timeWindowEnd: o.timeWindowEnd?.slice(0, 5) ?? null,
    serviceMinutes: o.serviceMinutes + o.extraMinutes,
    loadUnits: o.loadUnits,
    loadKg: o.loadKg,
    loadM3: o.loadM3,
  };
}

/**
 * RTE-01: orders that can go on a route for `date`: not on a route, and
 * awaiting/in warehouse (undated or due by then) or rescheduled to that date
 * (or overdue, so missed reschedules don't disappear).
 */
function eligibleFor(date: string): SQL {
  return and(
    isNull(orders.currentRouteId),
    or(
      and(inArray(orders.status, ['awaiting_scheduling', 'in_warehouse']), or(isNull(orders.scheduledDate), lte(orders.scheduledDate, date))),
      and(eq(orders.status, 'rescheduled'), lte(orders.scheduledDate, date)),
    ),
  )!;
}

const windowOf = (date: string, from: string | null, to: string | null): TimeWindow | null =>
  from && to ? { start: londonToUtc(date, from), end: londonToUtc(date, to) } : null;

const hasGeo = <T extends { lat: number | null; lng: number | null }>(o: T): o is T & { lat: number; lng: number } =>
  o.lat !== null && o.lng !== null;

function endPoint(endType: RouteEndType, depot: LatLng, home: { lat: number | null; lng: number | null } | null): LatLng | null {
  if (endType === 'last_stop') return null;
  if (endType === 'driver_home' && home && hasGeo(home)) return { lat: home.lat, lng: home.lng };
  return depot;
}

async function lockRoute(tx: Tx, id: string): Promise<RouteRow> {
  const [route] = await tx.select().from(routes).where(eq(routes.id, id)).for('update');
  if (!route) throw notFound('Route not found');
  return route;
}

function assertEditable(route: RouteRow) {
  if (!EDITABLE.includes(route.status)) {
    throw conflict('ROUTE_LOCKED', `${route.name} has ${route.status === 'completed' ? 'been completed' : 'already started'}; its stops can't be changed here`);
  }
}

async function event(tx: Tx, orderId: string, actor: AuthUser, type: string, routeId: string | null, payload: Record<string, unknown>) {
  await tx.insert(orderEvents).values({ orderId, actorId: actor.id, actorRole: actor.role, type, routeId, payload });
}

async function audit(tx: DbOrTx, actor: AuthUser, action: string, entityId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ actorId: actor.id, action, entity: 'route', entityId, details });
}

/** Take an order off its route, restoring the status it had before it was planned. */
async function revertFromRoute(tx: Tx, orderId: string, actor: AuthUser, routeName: string) {
  const order = await lockOrder(tx, orderId);
  if (order.status !== 'scheduled') return;
  const [prev] = await tx
    .select({ from: orderEvents.fromStatus })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.toStatus, 'scheduled')))
    .orderBy(desc(orderEvents.createdAt))
    .limit(1);
  const target: OrderStatus = prev?.from === 'rescheduled' && order.scheduledDate ? 'rescheduled' : 'awaiting_scheduling';
  await transitionOrder(tx, order, target, actor, {
    scheduledDate: target === 'rescheduled' ? order.scheduledDate : null,
    note: `Removed from ${routeName}`,
  });
}

/** Put a plannable order onto a route (→ Scheduled), or move a scheduled one between routes. */
async function assignToRoute(tx: Tx, orderId: string, route: RouteRow, actor: AuthUser): Promise<string | null> {
  const order = await lockOrder(tx, orderId);
  if (order.currentRouteId === route.id) return null;

  if (order.currentRouteId) {
    const from = await lockRoute(tx, order.currentRouteId);
    if (from.date !== route.date) throw conflict('WRONG_DATE', `${order.orderNumber} is on a route for another day`);
    assertEditable(from);
    await tx.delete(routeStops).where(and(eq(routeStops.routeId, from.id), eq(routeStops.orderId, orderId)));
    await tx.update(orders).set({ currentRouteId: route.id }).where(eq(orders.id, orderId));
    await event(tx, orderId, actor, 'route_changed', route.id, { from: from.name, to: route.name });
    if (from.status === 'released') await tx.update(routes).set({ changedAt: new Date() }).where(eq(routes.id, from.id));
    return from.id;
  }

  if (order.status === 'scheduled') {
    // Left over from a deleted draft: just attach it.
    await tx.update(orders).set({ currentRouteId: route.id, scheduledDate: route.date }).where(eq(orders.id, orderId));
    await event(tx, orderId, actor, 'route_assigned', route.id, { route: route.name });
    return null;
  }
  if (!PLANNABLE.includes(order.status as OrderPatchStatus)) {
    throw conflict('ORDER_NOT_PLANNABLE', `${order.orderNumber} is "${ORDER_STATUS_META[order.status].label}" and can't be put on a route`);
  }
  await transitionOrder(tx, order, 'scheduled', actor, {
    routeId: route.id,
    patch: { currentRouteId: route.id, scheduledDate: route.date },
    payload: { route: route.name },
  });
  return null;
}

async function resequence(tx: Tx, routeId: string) {
  const stops = await tx.select({ id: routeStops.id }).from(routeStops).where(eq(routeStops.routeId, routeId)).orderBy(asc(routeStops.sequence));
  for (const [i, s] of stops.entries()) await tx.update(routeStops).set({ sequence: i + 1 }).where(eq(routeStops.id, s.id));
}

// ---------- timings ----------

interface Timings {
  start: Date;
  end: Date;
  meters: number;
  seconds: number;
  polyline: string | null;
  engine: RoutingEngineKind;
  stops: { orderId: string; eta: Date | null; windowOk: boolean | null }[];
}

async function saveTimings(tx: DbOrTx, routeId: string, t: Timings) {
  await tx
    .update(routes)
    .set({
      plannedStart: t.start,
      plannedEnd: t.end,
      totalMiles: Math.round(metresToMiles(t.meters) * 10) / 10,
      driveMinutes: Math.round(t.seconds / 60),
      totalMinutes: Math.round((t.end.getTime() - t.start.getTime()) / 60_000),
      polyline: t.polyline,
      routingEngine: t.engine,
    })
    .where(eq(routes.id, routeId));
  if (t.stops.length === 0) return;
  // One statement for all stops: each round trip to the database counts.
  const values = sql.join(
    t.stops.map((s) => sql`(${s.orderId}::uuid, ${s.eta?.toISOString() ?? null}::timestamptz, ${s.windowOk}::boolean)`),
    sql`, `,
  );
  await tx.execute(sql`
    update route_stops as rs set eta = v.eta, eta_window_ok = v.ok
    from (values ${values}) as v(order_id, eta, ok)
    where rs.route_id = ${routeId} and rs.order_id = v.order_id`);
}

/** RTE-07: recompute ETAs, miles and durations for a route's current stop order. */
export async function recalculateRoute(ctx: PlanningContext, routeId: string): Promise<void> {
  const { db, routing } = ctx;
  const [route] = await db
    .select({
      id: routes.id,
      date: routes.date,
      status: routes.status,
      endType: routes.endType,
      startedAt: routes.startedAt,
      depotLat: depots.lat,
      depotLng: depots.lng,
      workStart: drivers.workStart,
      homeLat: drivers.homeLat,
      homeLng: drivers.homeLng,
    })
    .from(routes)
    .innerJoin(depots, eq(depots.id, routes.depotId))
    .leftJoin(drivers, eq(drivers.id, routes.driverId))
    .where(eq(routes.id, routeId));
  if (!route) throw notFound('Route not found');

  const stops = await db
    .select({
      orderId: orders.id,
      lat: orders.lat,
      lng: orders.lng,
      serviceMinutes: orders.serviceMinutes,
      extraMinutes: orders.extraMinutes,
      from: orders.timeWindowStart,
      to: orders.timeWindowEnd,
      completedAt: routeStops.completedAt,
    })
    .from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(eq(routeStops.routeId, routeId))
    .orderBy(asc(routeStops.sequence));

  const depot = { lat: route.depotLat, lng: route.depotLng };

  if (route.status === 'in_progress') {
    // On the road: completed stops keep their times; re-time the rest from the
    // last completed stop (or the depot), starting now.
    const done = stops.filter((s) => s.completedAt);
    const lastDone = done.filter(hasGeo).at(-1);
    const from = lastDone ? { lat: lastDone.lat, lng: lastDone.lng } : depot;
    const lastTime = Math.max(...done.map((s) => s.completedAt!.getTime()), route.startedAt?.getTime() ?? 0);
    const outstanding = stops.filter((s) => !s.completedAt && hasGeo(s)) as (typeof stops[number] & { lat: number; lng: number })[];
    const end = endPoint(route.endType, depot, { lat: route.homeLat, lng: route.homeLng });
    const legs = outstanding.length
      ? await routing.legs([from, ...outstanding.map((s) => ({ lat: s.lat, lng: s.lng })), ...(end ? [end] : [])])
      : { legs: [] };
    const schedule = computeSchedule(
      new Date(Math.max(Date.now(), lastTime)),
      outstanding.map((s) => ({ orderId: s.orderId, serviceSeconds: (s.serviceMinutes + s.extraMinutes) * 60, window: windowOf(route.date, s.from, s.to) })),
      legs.legs,
    );
    await db.transaction(async (tx) => {
      for (const s of schedule.stops) {
        await tx
          .update(routeStops)
          .set({ eta: s.start, etaWindowOk: s.windowOk })
          .where(and(eq(routeStops.routeId, routeId), eq(routeStops.orderId, s.orderId)));
      }
      await tx.update(routes).set({ plannedEnd: schedule.end }).where(eq(routes.id, routeId));
    });
    return;
  }
  const start = londonToUtc(route.date, route.workStart ?? DEFAULT_WORK_START);
  const located = stops.filter(hasGeo);
  const end = located.length ? endPoint(route.endType, depot, { lat: route.homeLat, lng: route.homeLng }) : null;
  const points = [depot, ...located.map((s) => ({ lat: s.lat, lng: s.lng })), ...(end ? [end] : [])];
  const legs = located.length ? await routing.legs(points) : { legs: [], polyline: null, engine: routing.travelKind };

  const schedule = computeSchedule(
    start,
    located.map((s) => ({
      orderId: s.orderId,
      serviceSeconds: (s.serviceMinutes + s.extraMinutes) * 60,
      window: windowOf(route.date, s.from, s.to),
    })),
    legs.legs,
  );
  const byOrder = new Map(schedule.stops.map((s) => [s.orderId, s]));
  await saveTimings(db, routeId, {
    start: schedule.start,
    end: located.length ? schedule.end : schedule.start,
    meters: schedule.meters,
    seconds: schedule.seconds,
    polyline: legs.polyline,
    engine: legs.engine,
    stops: stops.map((s) => {
      const st = byOrder.get(s.orderId);
      return { orderId: s.orderId, eta: st?.start ?? null, windowOk: st ? st.windowOk : null };
    }),
  });
}

// ---------- planner state (RTE-01, RTE-05, RTE-06, RTE-08) ----------

export async function getPlannerState(ctx: PlanningContext, date: string): Promise<PlannerState> {
  const { db, routing } = ctx;
  const [depotRows, driverRows, vanRows, routeRows, unassignedRows, settings] = await Promise.all([
    db.select().from(depots).where(eq(depots.active, true)).orderBy(desc(depots.isDefault), asc(depots.name)),
    db
      .select({
        id: drivers.id,
        name: users.name,
        defaultVanId: drivers.defaultVanId,
        workStart: drivers.workStart,
        workEnd: drivers.workEnd,
        maxHours: drivers.maxHours,
        homeLat: drivers.homeLat,
        homeLng: drivers.homeLng,
      })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .where(and(eq(drivers.active, true), eq(users.active, true)))
      .orderBy(asc(users.name)),
    db.select().from(vans).where(eq(vans.active, true)).orderBy(asc(vans.name)),
    db
      .select({
        route: routes,
        driverName: users.name,
        workEnd: drivers.workEnd,
        maxHours: drivers.maxHours,
        homeLat: drivers.homeLat,
        homeLng: drivers.homeLng,
        vanName: vans.name,
        vanRegistration: vans.registration,
        capacityUnits: vans.capacityUnits,
        capacityKg: vans.capacityKg,
        capacityM3: vans.capacityM3,
      })
      .from(routes)
      .leftJoin(drivers, eq(drivers.id, routes.driverId))
      .leftJoin(users, eq(users.id, drivers.userId))
      .leftJoin(vans, eq(vans.id, routes.vanId))
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name)),
    db.select(plannerOrderColumns).from(orders).where(eligibleFor(date)).orderBy(asc(orders.postcode)),
    getSettings(db),
  ]);

  const routeIds = routeRows.map((r) => r.route.id);
  const stopRows = routeIds.length
    ? await db
        .select({ stopId: routeStops.id, routeId: routeStops.routeId, sequence: routeStops.sequence, eta: routeStops.eta, etaWindowOk: routeStops.etaWindowOk, ...plannerOrderColumns })
        .from(routeStops)
        .innerJoin(orders, eq(orders.id, routeStops.orderId))
        .where(inArray(routeStops.routeId, routeIds))
        .orderBy(asc(routeStops.sequence))
    : [];

  const plannerRoutes: PlannerRoute[] = routeRows.map((row) => {
    const r = row.route;
    const stops = stopRows
      .filter((s) => s.routeId === r.id)
      .map((s) => ({
        id: s.stopId,
        sequence: s.sequence,
        eta: s.eta?.toISOString() ?? null,
        etaWindowOk: s.etaWindowOk,
        order: toPlannerOrder(s as PlannerOrderRow),
      }));
    const load = stops.reduce(
      (acc, s) => ({ u: acc.u + s.order.loadUnits, kg: acc.kg + s.order.loadKg, m3: acc.m3 + s.order.loadM3 }),
      { u: 0, kg: 0, m3: 0 },
    );
    const hasHomeLocation = row.homeLat !== null && row.homeLng !== null;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      depotId: r.depotId,
      endType: r.endType,
      driverId: r.driverId,
      driverName: row.driverName,
      vanId: r.vanId,
      vanName: row.vanName,
      vanRegistration: row.vanRegistration,
      capacityUnits: row.capacityUnits,
      loadUnits: load.u,
      plannedStart: r.plannedStart?.toISOString() ?? null,
      plannedEnd: r.plannedEnd?.toISOString() ?? null,
      totalMiles: r.totalMiles,
      driveMinutes: r.driveMinutes,
      totalMinutes: r.totalMinutes,
      polyline: r.polyline,
      engine: (r.routingEngine as RoutingEngineKind | null) ?? null,
      optimisedAt: r.optimisedAt?.toISOString() ?? null,
      releasedAt: r.releasedAt?.toISOString() ?? null,
      editable: EDITABLE.includes(r.status),
      stops,
      warnings: routeWarnings({
        status: r.status,
        driverId: r.driverId,
        vanId: r.vanId,
        endType: r.endType,
        hasHomeLocation,
        capacityUnits: row.capacityUnits,
        capacityKg: row.capacityKg,
        capacityM3: row.capacityM3,
        loadUnits: load.u,
        loadKg: load.kg,
        loadM3: load.m3,
        plannedStart: r.plannedStart,
        plannedEnd: r.plannedEnd,
        workEnd: row.workEnd ? londonToUtc(date, row.workEnd) : null,
        maxHours: row.maxHours,
        stops: stops.map((s) => ({
          orderId: s.order.id,
          orderNumber: s.order.orderNumber,
          etaWindowOk: s.etaWindowOk,
          hasGeocode: s.order.lat !== null && s.order.lng !== null,
        })),
      }),
    };
  });

  const unassigned = unassignedRows.map((o) => toPlannerOrder(o as PlannerOrderRow));
  const warnings: RouteWarning[] = [];
  if (unassigned.length) {
    warnings.push({
      code: 'unassigned',
      message: `${unassigned.length} order${unassigned.length === 1 ? '' : 's'} not on a route yet`,
      orderIds: unassigned.map((o) => o.id),
    });
  }
  const noGeo = unassigned.filter((o) => o.lat === null || o.lng === null);
  if (noGeo.length) {
    warnings.push({
      code: 'missing_geocode',
      message: `${noGeo.length} order${noGeo.length === 1 ? ' has' : 's have'} no map location and can't be optimised: ${noGeo
        .slice(0, 5)
        .map((o) => o.orderNumber)
        .join(', ')}${noGeo.length > 5 ? '…' : ''}`,
      orderIds: noGeo.map((o) => o.id),
    });
  }

  const busy = new Map<string, string[]>();
  for (const { route } of routeRows) {
    if (route.driverId && route.status !== 'draft') busy.set(route.driverId, [...(busy.get(route.driverId) ?? []), route.name]);
  }

  return {
    date,
    engines: { optimiser: routing.optimiserKind, travel: routing.travelKind },
    depots: depotRows.map((d) => ({
      id: d.id,
      name: d.name,
      address: d.address,
      postcode: d.postcode,
      lat: d.lat,
      lng: d.lng,
      isDefault: d.isDefault,
      active: d.active,
    })),
    defaultDepotId: depotRows.find((d) => d.isDefault)?.id ?? depotRows[0]?.id ?? null,
    defaultEndType: settings['routes.defaultEndType'],
    drivers: driverRows.map((d) => ({
      id: d.id,
      name: d.name,
      defaultVanId: d.defaultVanId,
      workStart: d.workStart.slice(0, 5),
      workEnd: d.workEnd.slice(0, 5),
      maxHours: d.maxHours,
      hasHomeLocation: d.homeLat !== null && d.homeLng !== null,
      busyRouteNames: busy.get(d.id) ?? [],
    })),
    vans: vanRows.map((v) => ({
      id: v.id,
      name: v.name,
      registration: v.registration,
      capacityUnits: v.capacityUnits,
      capacityKg: v.capacityKg,
      capacityM3: v.capacityM3,
    })),
    routes: plannerRoutes,
    unassigned,
    warnings,
  };
}

// ---------- optimise (RTE-03 – RTE-05) ----------

export interface OptimiseOutcome {
  routeIds: string[];
  skipped: OptimiseSkipped[];
  engine: RoutingEngineKind;
}

const ROUTE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export async function optimiseDay(
  ctx: PlanningContext,
  input: OptimiseRequest,
  actor: AuthUser,
  setPhase: (phase: string) => void = () => undefined,
): Promise<OptimiseOutcome> {
  const { db, routing } = ctx;
  const { date } = input;
  setPhase('Preparing orders and vehicles');

  const depot = await db.query.depots.findFirst({ where: and(eq(depots.id, input.depotId), eq(depots.active, true)) });
  if (!depot) throw badRequest('Choose an active depot');

  const driverIds = input.vehicles.map((v) => v.driverId);
  const vanIds = input.vehicles.map((v) => v.vanId);
  const [driverRows, vanRows] = await Promise.all([
    db
      .select({ driver: drivers, name: users.name, userActive: users.active })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .where(inArray(drivers.id, driverIds)),
    db.select().from(vans).where(inArray(vans.id, vanIds)),
  ]);
  for (const id of driverIds) {
    const d = driverRows.find((r) => r.driver.id === id);
    if (!d?.driver.active || !d.userActive) throw badRequest('One of the chosen drivers is not active');
  }
  for (const id of vanIds) if (!vanRows.find((v) => v.id === id)?.active) throw badRequest('One of the chosen vans is not active');

  // Released / started routes keep their driver and van; don't double-book them.
  const committed = await db
    .select({ name: routes.name, driverId: routes.driverId, vanId: routes.vanId })
    .from(routes)
    .where(and(eq(routes.date, date), ne(routes.status, 'draft')));
  for (const v of input.vehicles) {
    const byDriver = committed.find((r) => r.driverId === v.driverId);
    if (byDriver) {
      const name = driverRows.find((r) => r.driver.id === v.driverId)?.name ?? 'A driver';
      throw conflict('DRIVER_BUSY', `${name} already has ${byDriver.name} on this day`);
    }
    const byVan = committed.find((r) => r.vanId === v.vanId);
    if (byVan) {
      const van = vanRows.find((x) => x.id === v.vanId);
      throw conflict('VAN_BUSY', `${van?.name ?? 'A van'} is already used by ${byVan.name} on this day`);
    }
  }

  const drafts = await db.select({ id: routes.id }).from(routes).where(and(eq(routes.date, date), eq(routes.status, 'draft')));
  const draftIds = drafts.map((d) => d.id);
  const candidates = (await db
    .select(plannerOrderColumns)
    .from(orders)
    .where(draftIds.length ? or(eligibleFor(date), inArray(orders.currentRouteId, draftIds)) : eligibleFor(date))) as PlannerOrderRow[];

  const skipped: OptimiseSkipped[] = [];
  let pool = candidates;
  if (input.orderIds) {
    const wanted = new Set(input.orderIds);
    pool = candidates.filter((o) => wanted.has(o.id));
    const found = new Set(pool.map((o) => o.id));
    for (const id of input.orderIds) {
      if (!found.has(id)) skipped.push({ orderId: id, orderNumber: '', reason: 'No longer available for this date' });
    }
  }
  const located = pool.filter((o) => hasGeo(o));
  for (const o of pool) {
    if (!hasGeo(o)) skipped.push({ orderId: o.id, orderNumber: o.orderNumber, reason: 'No map location (address not geocoded)' });
  }

  const depotPoint = { lat: depot.lat, lng: depot.lng };
  const model: PlanningModel = {
    shipments: located.map((o) => ({
      orderId: o.id,
      location: { lat: o.lat!, lng: o.lng! },
      serviceSeconds: (o.serviceMinutes + o.extraMinutes) * 60,
      demand: o.loadUnits,
      window: windowOf(date, o.timeWindowStart, o.timeWindowEnd),
    })),
    vehicles: input.vehicles.map(({ driverId, vanId }) => {
      const { driver } = driverRows.find((r) => r.driver.id === driverId)!;
      const van = vanRows.find((v) => v.id === vanId)!;
      return {
        key: driverId,
        start: depotPoint,
        end: endPoint(input.endType, depotPoint, { lat: driver.homeLat, lng: driver.homeLng }),
        capacity: van.capacityUnits,
        startTime: londonToUtc(date, driver.workStart),
        endTime: londonToUtc(date, driver.workEnd),
        maxDurationSeconds: Math.round(driver.maxHours * 3600),
      };
    }),
  };

  setPhase(routing.optimiserKind === 'google' ? 'Optimising with Google Route Optimization' : 'Optimising routes (estimated travel times)');
  const result = await routing.optimise(model);

  setPhase('Saving draft routes');
  const byId = new Map(candidates.map((o) => [o.id, o]));
  for (const s of result.skipped) {
    skipped.push({ orderId: s.orderId, orderNumber: byId.get(s.orderId)?.orderNumber ?? '', reason: SKIP_REASON_TEXT[s.reason] });
  }

  const routeIds = await db.transaction(async (tx) => {
    // Re-optimising replaces this day's drafts. Their orders stay Scheduled for
    // now (FK sets current_route_id null); anything not re-planned is reverted below.
    const previouslyPlanned = candidates.filter((o) => o.currentRouteId && draftIds.includes(o.currentRouteId)).map((o) => o.id);
    if (draftIds.length) {
      await tx.select({ id: routes.id }).from(routes).where(inArray(routes.id, draftIds)).for('update');
      await tx.delete(routes).where(inArray(routes.id, draftIds));
    }

    const taken = new Set((await tx.select({ name: routes.name }).from(routes).where(eq(routes.date, date))).map((r) => r.name));
    const letters = [...ROUTE_LETTERS].map((l) => `Route ${l}`).filter((n) => !taken.has(n));
    const planned = new Set<string>();
    const created: string[] = [];
    const vehicleOrder = input.vehicles.map((v) => v.driverId);
    const sortedRoutes = [...result.routes].sort((a, b) => vehicleOrder.indexOf(a.vehicleKey) - vehicleOrder.indexOf(b.vehicleKey));

    for (const [i, plannedRoute] of sortedRoutes.entries()) {
      const vehicle = input.vehicles.find((v) => v.driverId === plannedRoute.vehicleKey)!;
      const [route] = await tx
        .insert(routes)
        .values({
          date,
          name: letters[i] ?? `Route ${i + 1}`,
          depotId: depot.id,
          endType: input.endType,
          driverId: vehicle.driverId,
          vanId: vehicle.vanId,
          status: 'draft',
          optimisedAt: new Date(),
        })
        .returning();
      if (!route) throw new Error('Route insert failed');
      created.push(route.id);

      const kept = [];
      for (const visit of plannedRoute.visits) {
        const order = await lockOrder(tx, visit.orderId);
        const ok = order.currentRouteId === null && (order.status === 'scheduled' || PLANNABLE.includes(order.status as OrderPatchStatus));
        if (!ok) {
          skipped.push({ orderId: order.id, orderNumber: order.orderNumber, reason: 'Changed by someone else while optimising' });
          continue;
        }
        await tx.insert(routeStops).values({ routeId: route.id, orderId: order.id, sequence: kept.length + 1 });
        await assignToRoute(tx, order.id, route, actor);
        planned.add(order.id);
        kept.push(visit);
      }

      const windows = new Map(located.map((o) => [o.id, windowOf(date, o.timeWindowStart, o.timeWindowEnd)]));
      await saveTimings(tx, route.id, {
        start: plannedRoute.startTime,
        end: plannedRoute.endTime,
        meters: plannedRoute.distanceMeters,
        seconds: plannedRoute.travelSeconds,
        polyline: plannedRoute.polyline,
        engine: result.engine,
        stops: kept.map((v) => {
          const w = windows.get(v.orderId);
          return { orderId: v.orderId, eta: v.start, windowOk: !w || v.start <= w.end };
        }),
      });
    }

    for (const orderId of previouslyPlanned) {
      if (!planned.has(orderId)) await revertFromRoute(tx, orderId, actor, 'draft plan');
    }
    await audit(tx, actor, 'routes_optimised', date, {
      date,
      engine: result.engine,
      routes: created.length,
      planned: planned.size,
      skipped: skipped.length,
    });
    return created;
  });

  // The local optimiser plans on estimates; switch to real road times when available.
  if (result.engine === 'estimate' && routing.travelKind === 'google' && routeIds.length) {
    setPhase('Calculating road times');
    for (const id of routeIds) await recalculateRoute(ctx, id);
  }
  return { routeIds, skipped, engine: result.engine };
}

// ---------- manual edits (RTE-07) ----------

/** Replace a route's stop list: reorder, add (from unassigned or another route) and remove. */
export async function setRouteStops(ctx: PlanningContext, routeId: string, orderIds: string[], actor: AuthUser): Promise<void> {
  const affected = new Set<string>([routeId]);
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    assertEditable(route);
    const current = (
      await tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, routeId)).orderBy(asc(routeStops.sequence))
    ).map((s) => s.orderId);

    const removed = current.filter((id) => !orderIds.includes(id));
    const added = orderIds.filter((id) => !current.includes(id));
    for (const id of removed) await revertFromRoute(tx, id, actor, route.name);
    for (const id of added) {
      const from = await assignToRoute(tx, id, route, actor);
      if (from) affected.add(from);
    }

    await tx.delete(routeStops).where(eq(routeStops.routeId, routeId));
    if (orderIds.length) {
      await tx.insert(routeStops).values(orderIds.map((orderId, i) => ({ routeId, orderId, sequence: i + 1 })));
    }
    for (const other of affected) if (other !== routeId) await resequence(tx, other);

    const reordered = current.filter((id) => orderIds.includes(id)).join() !== orderIds.filter((id) => current.includes(id)).join();
    if (route.status === 'released' && (added.length || removed.length || reordered)) {
      // RTE-09: the driver app highlights the change; history records what changed.
      await tx.update(routes).set({ changedAt: new Date() }).where(eq(routes.id, routeId));
      for (const id of orderIds.filter((o) => current.includes(o))) {
        if (reordered) await event(tx, id, actor, 'route_resequenced', routeId, { route: route.name });
      }
      await audit(tx, actor, 'released_route_edited', routeId, { added, removed, reordered });
    }
  });
  for (const id of affected) await recalculateRoute(ctx, id);
}

/**
 * DRV-05: move individual stops to another route on the same day, including
 * outstanding stops of a route already on the road (e.g. a van breaks down).
 * Moved stops go to the end of the target route; both drivers' apps update.
 */
export async function transferStops(
  ctx: PlanningContext,
  fromRouteId: string,
  orderIds: string[],
  toRouteId: string,
  actor: AuthUser,
): Promise<void> {
  if (fromRouteId === toRouteId) throw badRequest('Choose a different route');
  await ctx.db.transaction(async (tx) => {
    // Lock in a fixed order so two opposite transfers can't deadlock.
    const [a, b] = [fromRouteId, toRouteId].sort();
    const locked = new Map([[a!, await lockRoute(tx, a!)], [b!, await lockRoute(tx, b!)]]);
    const from = locked.get(fromRouteId)!;
    const to = locked.get(toRouteId)!;
    if (from.date !== to.date) throw conflict('WRONG_DATE', 'Stops can only move to a route on the same day');
    for (const r of [from, to]) {
      if (r.status === 'completed') throw conflict('ROUTE_LOCKED', `${r.name} has been completed`);
    }

    const stops = await tx
      .select({ orderId: routeStops.orderId, completedAt: routeStops.completedAt, status: orders.status, number: orders.orderNumber })
      .from(routeStops)
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .where(and(eq(routeStops.routeId, fromRouteId), inArray(routeStops.orderId, orderIds)));
    if (stops.length !== orderIds.length) throw badRequest(`Some of those orders are not on ${from.name}`);
    const done = stops.filter((s) => s.completedAt);
    if (done.length) throw conflict('STOP_COMPLETED', `Already completed: ${done.map((s) => s.number).join(', ')}`);
    const outForDelivery = stops.filter((s) => s.status === 'out_for_delivery');
    if (outForDelivery.length && to.status === 'draft') {
      throw conflict('ROUTE_NOT_RELEASED', `${outForDelivery.map((s) => s.number).join(', ')} ${outForDelivery.length > 1 ? 'are' : 'is'} already out for delivery – move to a released or in-progress route`);
    }

    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${routeStops.sequence}), 0)`.mapWith(Number) })
      .from(routeStops)
      .where(eq(routeStops.routeId, toRouteId));
    await tx.delete(routeStops).where(and(eq(routeStops.routeId, fromRouteId), inArray(routeStops.orderId, orderIds)));
    await tx.insert(routeStops).values(orderIds.map((orderId, i) => ({ routeId: toRouteId, orderId, sequence: next + i + 1 })));
    await resequence(tx, fromRouteId);
    await tx.update(orders).set({ currentRouteId: toRouteId }).where(inArray(orders.id, orderIds));

    const driverIds = [from.driverId, to.driverId].filter((x): x is string => !!x);
    const driverNames = driverIds.length
      ? await tx.select({ id: drivers.id, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(inArray(drivers.id, driverIds))
      : [];
    const nameOf = (id: string | null) => driverNames.find((d) => d.id === id)?.name ?? null;
    for (const orderId of orderIds) {
      await event(tx, orderId, actor, 'route_changed', toRouteId, {
        from: from.name,
        to: to.name,
        fromDriver: nameOf(from.driverId),
        toDriver: nameOf(to.driverId),
      });
    }
    const now = new Date();
    for (const r of [from, to]) if (r.status !== 'draft') await tx.update(routes).set({ changedAt: now }).where(eq(routes.id, r.id));
    await audit(tx, actor, 'stops_transferred', fromRouteId, { to: toRouteId, orderIds });
  });
  await recalculateRoute(ctx, fromRouteId);
  await recalculateRoute(ctx, toRouteId);
}

/** RTE-07 "re-optimise this route": best order for the same stops and vehicle. */
export async function reoptimiseRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<{ skipped: OptimiseSkipped[] }> {
  const { db, routing } = ctx;
  const [row] = await db
    .select({ route: routes, depot: depots, driver: drivers, capacity: vans.capacityUnits })
    .from(routes)
    .innerJoin(depots, eq(depots.id, routes.depotId))
    .leftJoin(drivers, eq(drivers.id, routes.driverId))
    .leftJoin(vans, eq(vans.id, routes.vanId))
    .where(eq(routes.id, routeId));
  if (!row) throw notFound('Route not found');
  assertEditable(row.route);
  const { route, depot, driver } = row;

  const stops = (await db
    .select(plannerOrderColumns)
    .from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(eq(routeStops.routeId, routeId))
    .orderBy(asc(routeStops.sequence))) as PlannerOrderRow[];
  if (stops.length < 2) return { skipped: [] };

  const depotPoint = { lat: depot.lat, lng: depot.lng };
  const located = stops.filter(hasGeo);
  const result = await routing.optimise({
    shipments: located.map((o) => ({
      orderId: o.id,
      location: { lat: o.lat!, lng: o.lng! },
      serviceSeconds: (o.serviceMinutes + o.extraMinutes) * 60,
      demand: o.loadUnits,
      window: windowOf(route.date, o.timeWindowStart, o.timeWindowEnd),
    })),
    vehicles: [
      {
        key: 'route',
        start: depotPoint,
        end: endPoint(route.endType, depotPoint, driver ? { lat: driver.homeLat, lng: driver.homeLng } : null),
        // Re-ordering can't change the load, so don't let capacity skip stops here.
        capacity: null,
        startTime: londonToUtc(route.date, driver?.workStart ?? DEFAULT_WORK_START),
        endTime: londonToUtc(route.date, driver?.workEnd ?? DEFAULT_WORK_END),
        maxDurationSeconds: null,
      },
    ],
  });

  // Never drop stops: anything the optimiser couldn't fit keeps its place at the end.
  const order = result.routes[0]?.visits.map((v) => v.orderId) ?? [];
  const rest = stops.map((s) => s.id).filter((id) => !order.includes(id));
  await setRouteStops(ctx, routeId, [...order, ...rest], actor);
  await db.update(routes).set({ optimisedAt: new Date() }).where(eq(routes.id, routeId));

  const byId = new Map(stops.map((s) => [s.id, s.orderNumber]));
  return {
    skipped: result.skipped.map((s) => ({
      orderId: s.orderId,
      orderNumber: byId.get(s.orderId) ?? '',
      reason: `${SKIP_REASON_TEXT[s.reason]} – kept at the end of the route`,
    })),
  };
}

export async function updateRoute(ctx: PlanningContext, routeId: string, input: RouteUpdateInput, actor: AuthUser): Promise<void> {
  let needsRecalc = false;
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    if (route.status === 'completed') throw conflict('ROUTE_LOCKED', 'Completed routes cannot be changed');
    if (input.endType !== undefined && input.endType !== route.endType) {
      assertEditable(route);
      needsRecalc = true;
    }
    let driverName: string | null = null;
    if (input.driverId) {
      const [d] = await tx
        .select({ active: drivers.active, name: users.name })
        .from(drivers)
        .innerJoin(users, eq(users.id, drivers.userId))
        .where(eq(drivers.id, input.driverId));
      if (!d?.active) throw badRequest('That driver is not active');
      driverName = d.name;
    }
    if (input.vanId) {
      const [v] = await tx.select({ active: vans.active }).from(vans).where(eq(vans.id, input.vanId));
      if (!v?.active) throw badRequest('That van is not active');
    }
    if (input.name && input.name !== route.name) {
      const [clash] = await tx
        .select({ id: routes.id })
        .from(routes)
        .where(and(eq(routes.date, route.date), eq(routes.name, input.name)));
      if (clash) throw conflict('DUPLICATE_NAME', `There is already a ${input.name} on this day`);
    }

    const driverChanged = input.driverId !== undefined && input.driverId !== route.driverId;
    const vanChanged = input.vanId !== undefined && input.vanId !== route.vanId;
    if (driverChanged) needsRecalc = true; // working hours / home location may differ
    const reassigned = route.status !== 'draft' && (driverChanged || vanChanged);
    await tx
      .update(routes)
      .set({ ...input, ...(reassigned && { changedAt: new Date() }) })
      .where(eq(routes.id, routeId));

    if (reassigned) {
      // DRV-05: reassignment is recorded on every affected order.
      const stopOrders = await tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, routeId));
      for (const { orderId } of stopOrders) {
        await event(tx, orderId, actor, 'route_reassigned', routeId, {
          route: route.name,
          ...(driverChanged && { driver: driverName }),
          ...(vanChanged && { vanId: input.vanId }),
        });
      }
      await audit(tx, actor, 'route_reassigned', routeId, { driverId: input.driverId, vanId: input.vanId });
    }
  });
  if (needsRecalc) await recalculateRoute(ctx, routeId);
}

// ---------- lifecycle (RTE-09) ----------

export async function releaseRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    if (route.status !== 'draft') throw conflict('INVALID_ROUTE_STATE', `${route.name} is already ${route.status.replace('_', ' ')}`);
    if (!route.driverId || !route.vanId) throw conflict('ROUTE_INCOMPLETE', 'Assign a driver and a van before releasing');
    const stops = await tx
      .select({ orderId: routeStops.orderId, lat: orders.lat, number: orders.orderNumber })
      .from(routeStops)
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .where(eq(routeStops.routeId, routeId));
    if (stops.length === 0) throw conflict('ROUTE_INCOMPLETE', 'Add at least one stop before releasing');
    const noGeo = stops.filter((s) => s.lat === null);
    if (noGeo.length) {
      throw conflict('ROUTE_INCOMPLETE', `These stops have no map location: ${noGeo.map((s) => s.number).join(', ')}`);
    }
    await tx.update(routes).set({ status: 'released', releasedAt: new Date(), changedAt: null }).where(eq(routes.id, routeId));
    for (const s of stops) await event(tx, s.orderId, actor, 'route_released', routeId, { route: route.name });
    await audit(tx, actor, 'route_released', routeId, { stops: stops.length });
  });
}

export async function unreleaseRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    if (route.status !== 'released') throw conflict('INVALID_ROUTE_STATE', `Only released routes can be moved back to draft`);
    await tx.update(routes).set({ status: 'draft', releasedAt: null, changedAt: new Date() }).where(eq(routes.id, routeId));
    const stopOrders = await tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, routeId));
    for (const { orderId } of stopOrders) await event(tx, orderId, actor, 'route_unreleased', routeId, { route: route.name });
    await audit(tx, actor, 'route_unreleased', routeId, {});
  });
}

export async function deleteRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    assertEditable(route);
    const stopOrders = await tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, routeId));
    for (const { orderId } of stopOrders) await revertFromRoute(tx, orderId, actor, route.name);
    await tx.delete(routes).where(eq(routes.id, routeId));
    await audit(tx, actor, 'route_deleted', routeId, { name: route.name, date: route.date, status: route.status });
  });
}

/** Thrown for "can't optimise twice at once" etc. */
export const busy = (message: string) => new AppError(409, 'BUSY', message);
