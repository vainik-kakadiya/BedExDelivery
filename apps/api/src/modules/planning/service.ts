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
  type GeocodeStatus,
  type OrderStatus,
  type PlannerOrder,
  type PlannerRoute,
  type PlannerState,
  type RouteEndType,
  type RouteStatus,
  type RouteUpdateInput,
  type RouteWarning,
  type RoutingEngineKind,
  type VanDeactivateInput,
  type VanImpact,
  checkTransition,
  londonToUtc,
  metresToMiles,
} from '@bedex/shared';
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import { getSettings } from '../settings/service';
import { type LatLng, type PlanningModel, type RoutingEngine, SKIP_REASON_TEXT, type TimeWindow, estimateLegs } from './engine';
import { computeSchedule, overCapacity, routeWarnings } from './schedule';

export interface PlanningContext {
  db: Db;
  routing: RoutingEngine;
}

type RouteRow = typeof routes.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type EventInsert = typeof orderEvents.$inferInsert;
type OrderPatchStatus = Extract<OrderStatus, 'awaiting_scheduling' | 'in_warehouse' | 'rescheduled'>;

/** Statuses an order can be planned from (RTE-01). */
const PLANNABLE: OrderPatchStatus[] = ['awaiting_scheduling', 'in_warehouse', 'rescheduled'];
/** Stops can change until the driver starts the route. */
const EDITABLE: RouteStatus[] = ['draft', 'released'];
const DEFAULT_WORK_START = '08:00';

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
  geocodeStatus: orders.geocodeStatus,
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
  geocodeStatus: GeocodeStatus;
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
    geocodeStatus: o.geocodeStatus,
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

/*
 * The database (Supabase) is usually a long way from the API in network terms,
 * so every round trip costs ~100 ms+. The helpers below therefore work on whole
 * lists with a fixed number of statements, never one statement per order, and
 * statements that don't depend on each other are sent together (postgres.js
 * pipelines them on the transaction's connection).
 */

const eventRow = (actor: AuthUser, orderId: string, type: string, routeId: string | null, payload: Record<string, unknown>): EventInsert => ({
  orderId,
  actorId: actor.id,
  actorRole: actor.role,
  type,
  routeId,
  payload,
});

/** Same row transitionOrder() writes for a status change. */
const statusEventRow = (
  actor: AuthUser,
  order: OrderRow,
  to: OrderStatus,
  routeId: string | null,
  extra: { note?: string; payload?: Record<string, unknown> } = {},
): EventInsert => ({
  ...eventRow(actor, order.id, 'status_changed', routeId, extra.payload ?? {}),
  fromStatus: order.status,
  toStatus: to,
  driverId: actor.driverId,
  note: extra.note ?? null,
});

async function insertEvents(tx: Tx, rows: EventInsert[]) {
  if (rows.length) await tx.insert(orderEvents).values(rows);
}

async function audit(tx: DbOrTx, actor: AuthUser, action: string, entityId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ actorId: actor.id, action, entity: 'route', entityId, details });
}

/** Lock orders in id order, so two planners locking overlapping sets can't deadlock. */
async function lockOrders(tx: Tx, ids: string[]): Promise<Map<string, OrderRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(orders).where(inArray(orders.id, ids)).orderBy(asc(orders.id)).for('update');
  return new Map(rows.map((o) => [o.id, o]));
}

function assertTransition(order: OrderRow, to: OrderStatus, actor: AuthUser) {
  const check = checkTransition(order.status, to, actor.role);
  if (!check.ok) throw conflict('INVALID_TRANSITION', `${order.orderNumber}: ${check.reason}`, { from: order.status, to });
}

/**
 * Take orders off their route, restoring the status each had before it was
 * planned (Rescheduled keeps its date, otherwise Awaiting scheduling). The
 * caller removes the route_stops rows.
 */
async function revertFromRoute(tx: Tx, orderIds: string[], actor: AuthUser, routeName: string): Promise<void> {
  const scheduled = [...(await lockOrders(tx, orderIds)).values()].filter((o) => o.status === 'scheduled');
  if (scheduled.length === 0) return;
  const previous = await tx
    .selectDistinctOn([orderEvents.orderId], { orderId: orderEvents.orderId, from: orderEvents.fromStatus })
    .from(orderEvents)
    .where(and(inArray(orderEvents.orderId, scheduled.map((o) => o.id)), eq(orderEvents.toStatus, 'scheduled')))
    .orderBy(orderEvents.orderId, desc(orderEvents.createdAt));
  const cameFrom = new Map(previous.map((p) => [p.orderId, p.from]));

  const toRescheduled: string[] = [];
  const toAwaiting: string[] = [];
  const events: EventInsert[] = [];
  for (const o of scheduled) {
    const target: OrderStatus = cameFrom.get(o.id) === 'rescheduled' && o.scheduledDate ? 'rescheduled' : 'awaiting_scheduling';
    assertTransition(o, target, actor);
    (target === 'rescheduled' ? toRescheduled : toAwaiting).push(o.id);
    events.push(
      statusEventRow(actor, o, target, o.currentRouteId, {
        note: `Removed from ${routeName}`,
        payload: target === 'rescheduled' ? { scheduledDate: o.scheduledDate } : {},
      }),
    );
  }
  await Promise.all([
    toRescheduled.length && tx.update(orders).set({ status: 'rescheduled', currentRouteId: null }).where(inArray(orders.id, toRescheduled)),
    toAwaiting.length &&
      tx.update(orders).set({ status: 'awaiting_scheduling', currentRouteId: null, scheduledDate: null }).where(inArray(orders.id, toAwaiting)),
    insertEvents(tx, events),
  ]);
}

/**
 * Put orders onto `route` (→ Scheduled), or move scheduled ones over from another
 * route on the same day. The caller writes the route_stops rows for `route`.
 * Returns the ids of the routes orders were moved from.
 */
async function attachToRoute(tx: Tx, orderIds: string[], route: RouteRow, actor: AuthUser): Promise<string[]> {
  const locked = await lockOrders(tx, orderIds);
  const moving: OrderRow[] = [];
  const unplanned: OrderRow[] = [];
  for (const id of orderIds) {
    const o = locked.get(id);
    if (!o) throw notFound('Order not found');
    if (o.currentRouteId === route.id) continue;
    // RTE-08 hard rule: a stop without a map location gets no ETA and can't be driven to.
    if (o.lat === null || o.lng === null) {
      throw conflict('NO_LOCATION', `${o.orderNumber} has no map location yet. Fix its address or drop a pin on the map first.`);
    }
    if (o.currentRouteId) moving.push(o);
    else if (o.status === 'scheduled') unplanned.push(o); // left over from a deleted draft
    else if (PLANNABLE.includes(o.status as OrderPatchStatus)) {
      assertTransition(o, 'scheduled', actor);
      unplanned.push(o);
    } else {
      throw conflict('ORDER_NOT_PLANNABLE', `${o.orderNumber} is "${ORDER_STATUS_META[o.status].label}" and can't be put on a route`);
    }
  }

  const fromIds = [...new Set(moving.map((o) => o.currentRouteId!))];
  const sources = fromIds.length
    ? await tx.select().from(routes).where(inArray(routes.id, fromIds)).orderBy(asc(routes.id)).for('update')
    : [];
  const sourceById = new Map(sources.map((r) => [r.id, r]));

  const events: EventInsert[] = [];
  for (const o of moving) {
    const from = sourceById.get(o.currentRouteId!)!;
    if (from.date !== route.date) throw conflict('WRONG_DATE', `${o.orderNumber} is on a route for another day`);
    assertEditable(from);
    events.push(eventRow(actor, o.id, 'route_changed', route.id, { from: from.name, to: route.name }));
  }
  for (const o of unplanned) {
    events.push(
      o.status === 'scheduled'
        ? eventRow(actor, o.id, 'route_assigned', route.id, { route: route.name })
        : statusEventRow(actor, o, 'scheduled', route.id, { payload: { route: route.name } }),
    );
  }
  if (events.length === 0) return [];

  const releasedSources = sources.filter((r) => r.status === 'released').map((r) => r.id);
  await Promise.all([
    moving.length &&
      tx.delete(routeStops).where(and(inArray(routeStops.routeId, fromIds), inArray(routeStops.orderId, moving.map((o) => o.id)))),
    moving.length && tx.update(orders).set({ currentRouteId: route.id }).where(inArray(orders.id, moving.map((o) => o.id))),
    unplanned.length &&
      tx
        .update(orders)
        .set({ status: 'scheduled', currentRouteId: route.id, scheduledDate: route.date })
        .where(inArray(orders.id, unplanned.map((o) => o.id))),
    releasedSources.length && tx.update(routes).set({ changedAt: new Date() }).where(inArray(routes.id, releasedSources)),
    insertEvents(tx, events),
  ]);
  return fromIds;
}

/** Renumber stops 1..n (after some were taken out), in one statement. */
async function resequence(tx: Tx, routeIds: string[]) {
  if (routeIds.length === 0) return;
  const ids = sql.join(
    routeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    update route_stops as rs set sequence = n.seq
    from (
      select id, row_number() over (partition by route_id order by sequence) as seq
      from route_stops where route_id in (${ids})
    ) as n
    where rs.id = n.id and rs.sequence <> n.seq`);
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

/** Write every stop's ETA in one statement. */
async function saveStopEtas(tx: DbOrTx, routeId: string, stops: Timings['stops']) {
  if (stops.length === 0) return;
  const values = sql.join(
    stops.map((s) => sql`(${s.orderId}::uuid, ${s.eta?.toISOString() ?? null}::timestamptz, ${s.windowOk}::boolean)`),
    sql`, `,
  );
  await tx.execute(sql`
    update route_stops as rs set eta = v.eta, eta_window_ok = v.ok
    from (values ${values}) as v(order_id, eta, ok)
    where rs.route_id = ${routeId} and rs.order_id = v.order_id`);
}

async function saveTimings(tx: DbOrTx, routeId: string, t: Timings) {
  await Promise.all([
    tx
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
      .where(eq(routes.id, routeId)),
    saveStopEtas(tx, routeId, t.stops),
  ]);
}

/** RTE-07: recompute ETAs, miles and durations for a route's current stop order. */
export async function recalculateRoute(ctx: PlanningContext, routeId: string): Promise<void> {
  const { db, routing } = ctx;
  const [[route], stops] = await Promise.all([
    db
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
      .where(eq(routes.id, routeId)),
    db
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
      .orderBy(asc(routeStops.sequence)),
  ]);
  if (!route) throw notFound('Route not found');

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
    await Promise.all([
      saveStopEtas(
        db,
        routeId,
        schedule.stops.map((s) => ({ orderId: s.orderId, eta: s.start, windowOk: s.windowOk })),
      ),
      db.update(routes).set({ plannedEnd: schedule.end }).where(eq(routes.id, routeId)),
    ]);
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
      message: `${noGeo.length} order${noGeo.length === 1 ? ' has' : 's have'} no map location and can't be planned: ${noGeo
        .slice(0, 5)
        .map((o) => o.orderNumber)
        .join(', ')}${noGeo.length > 5 ? '…' : ''}. Use "Fix location" to correct the address or drop a pin.`,
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

    const vehicleOrder = input.vehicles.map((v) => v.driverId);
    const sortedRoutes = result.routes
      .filter((r) => r.visits.length > 0)
      .sort((a, b) => vehicleOrder.indexOf(a.vehicleKey) - vehicleOrder.indexOf(b.vehicleKey));
    const [takenRows, locked] = await Promise.all([
      tx.select({ name: routes.name }).from(routes).where(eq(routes.date, date)),
      lockOrders(tx, sortedRoutes.flatMap((r) => r.visits.map((v) => v.orderId))),
    ]);
    const taken = new Set(takenRows.map((r) => r.name));
    const letters = [...ROUTE_LETTERS].map((l) => `Route ${l}`).filter((n) => !taken.has(n));

    const inserted = sortedRoutes.length
      ? await tx
          .insert(routes)
          .values(
            sortedRoutes.map((plannedRoute, i) => {
              const vehicle = input.vehicles.find((v) => v.driverId === plannedRoute.vehicleKey)!;
              return {
                date,
                name: letters[i] ?? `Route ${i + 1}`,
                depotId: depot.id,
                endType: input.endType,
                driverId: vehicle.driverId,
                vanId: vehicle.vanId,
                status: 'draft' as const,
                optimisedAt: new Date(),
              };
            }),
          )
          .returning()
      : [];
    // One route per driver, so the driver identifies the inserted row.
    const routeFor = new Map(inserted.map((r) => [r.driverId!, r]));

    const planned = new Set<string>();
    const windows = new Map(located.map((o) => [o.id, windowOf(date, o.timeWindowStart, o.timeWindowEnd)]));
    // Run after the stops exist (calling these starts their queries straight away).
    const writes: (() => Promise<unknown>)[] = [];
    const stopRows: (typeof routeStops.$inferInsert)[] = [];
    for (const plannedRoute of sortedRoutes) {
      const route = routeFor.get(plannedRoute.vehicleKey)!;
      const kept = plannedRoute.visits.filter((visit) => {
        const order = locked.get(visit.orderId);
        const ok =
          !!order &&
          order.currentRouteId === null &&
          (order.status === 'scheduled' || PLANNABLE.includes(order.status as OrderPatchStatus));
        if (!ok) {
          skipped.push({ orderId: visit.orderId, orderNumber: order?.orderNumber ?? '', reason: 'Changed by someone else while optimising' });
        }
        return ok;
      });
      kept.forEach((v, i) => {
        stopRows.push({ routeId: route.id, orderId: v.orderId, sequence: i + 1 });
        planned.add(v.orderId);
      });
      writes.push(() => attachToRoute(tx, kept.map((v) => v.orderId), route, actor));
      writes.push(() =>
        saveTimings(tx, route.id, {
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
        }),
      );
    }
    // Stops first: the ETA updates in saveTimings need the rows to exist.
    if (stopRows.length) await tx.insert(routeStops).values(stopRows);
    await Promise.all(writes.map((write) => write()));
    await revertFromRoute(
      tx,
      previouslyPlanned.filter((id) => !planned.has(id)),
      actor,
      'draft plan',
    );
    await audit(tx, actor, 'routes_optimised', date, {
      date,
      engine: result.engine,
      routes: inserted.length,
      planned: planned.size,
      skipped: skipped.length,
    });
    return inserted.map((r) => r.id);
  });

  // The local optimiser plans on estimates; switch to real road times when available.
  if (result.engine === 'estimate' && routing.travelKind === 'google' && routeIds.length) {
    setPhase('Calculating road times');
    await Promise.all(routeIds.map((id) => recalculateRoute(ctx, id)));
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
    await revertFromRoute(tx, removed, actor, route.name);
    for (const from of await attachToRoute(tx, added, route, actor)) affected.add(from);

    await tx.delete(routeStops).where(eq(routeStops.routeId, routeId));
    if (orderIds.length) {
      await tx.insert(routeStops).values(orderIds.map((orderId, i) => ({ routeId, orderId, sequence: i + 1 })));
    }
    await resequence(
      tx,
      [...affected].filter((id) => id !== routeId),
    );

    const reordered = current.filter((id) => orderIds.includes(id)).join() !== orderIds.filter((id) => current.includes(id)).join();
    if (route.status === 'released' && (added.length || removed.length || reordered)) {
      // RTE-09: the driver app highlights the change; history records what changed.
      await Promise.all([
        tx.update(routes).set({ changedAt: new Date() }).where(eq(routes.id, routeId)),
        reordered &&
          insertEvents(
            tx,
            orderIds.filter((o) => current.includes(o)).map((id) => eventRow(actor, id, 'route_resequenced', routeId, { route: route.name })),
          ),
        audit(tx, actor, 'released_route_edited', routeId, { added, removed, reordered }),
      ]);
    }
  });
  await Promise.all([...affected].map((id) => recalculateRoute(ctx, id)));
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
    await moveStops(tx, locked.get(fromRouteId)!, locked.get(toRouteId)!, orderIds, actor);
  });
  await Promise.all([recalculateRoute(ctx, fromRouteId), recalculateRoute(ctx, toRouteId)]);
}

/** transferStops() on routes the caller has already locked. The caller recalculates both. */
async function moveStops(tx: Tx, from: RouteRow, to: RouteRow, orderIds: string[], actor: AuthUser, note?: string): Promise<void> {
  const fromRouteId = from.id;
  const toRouteId = to.id;
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

  const driverIds = [from.driverId, to.driverId].filter((x): x is string => !!x);
  const [[{ next } = { next: 0 }], driverNames] = await Promise.all([
    tx
      .select({ next: sql<number>`coalesce(max(${routeStops.sequence}), 0)`.mapWith(Number) })
      .from(routeStops)
      .where(eq(routeStops.routeId, toRouteId)),
    driverIds.length
      ? tx.select({ id: drivers.id, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(inArray(drivers.id, driverIds))
      : [],
  ]);
  await tx.delete(routeStops).where(and(eq(routeStops.routeId, fromRouteId), inArray(routeStops.orderId, orderIds)));
  const nameOf = (id: string | null) => driverNames.find((d) => d.id === id)?.name ?? null;
  const changed = [from, to].filter((r) => r.status !== 'draft').map((r) => r.id);
  await Promise.all([
    tx.insert(routeStops).values(orderIds.map((orderId, i) => ({ routeId: toRouteId, orderId, sequence: next + i + 1 }))),
    resequence(tx, [fromRouteId]),
    tx.update(orders).set({ currentRouteId: toRouteId }).where(inArray(orders.id, orderIds)),
    insertEvents(
      tx,
      orderIds.map((orderId) =>
        eventRow(actor, orderId, 'route_changed', toRouteId, {
          from: from.name,
          to: to.name,
          fromDriver: nameOf(from.driverId),
          toDriver: nameOf(to.driverId),
          ...(note && { reason: note }),
        }),
      ),
    ),
    changed.length && tx.update(routes).set({ changedAt: new Date() }).where(inArray(routes.id, changed)),
    audit(tx, actor, 'stops_transferred', fromRouteId, { to: toRouteId, orderIds, ...(note && { reason: note }) }),
  ]);
}

export interface ReoptimiseOutcome {
  skipped: OptimiseSkipped[];
  /** False when the current order was already as good as anything found. */
  changed: boolean;
}

/** One Routes API (or estimate) call for a candidate stop order: lateness first, then time, then distance. */
async function judgeOrder(
  routing: RoutingEngine,
  start: Date,
  depot: LatLng,
  end: LatLng | null,
  ordered: (PlannerOrderRow & { lat: number; lng: number })[],
  date: string,
) {
  const legs = await routing.legs([depot, ...ordered.map((o) => ({ lat: o.lat, lng: o.lng })), ...(end ? [end] : [])]);
  const schedule = computeSchedule(
    start,
    ordered.map((o) => ({
      orderId: o.id,
      serviceSeconds: (o.serviceMinutes + o.extraMinutes) * 60,
      window: windowOf(date, o.timeWindowStart, o.timeWindowEnd),
    })),
    legs.legs,
  );
  return {
    engine: legs.engine,
    late: schedule.stops.filter((s) => !s.windowOk).length,
    cost: schedule.seconds + schedule.meters / 1000,
  };
}

/**
 * RTE-07 "re-optimise this route": best order for the same stops and vehicle.
 * The proposal is checked on the same travel times the route is shown with
 * (real roads when the Routes API is set up) and only kept if it is better, so
 * re-optimising never makes a route longer.
 */
export async function reoptimiseRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<ReoptimiseOutcome> {
  const { db, routing } = ctx;
  const [[row], stops] = await Promise.all([
    db
      .select({ route: routes, depot: depots, driver: drivers })
      .from(routes)
      .innerJoin(depots, eq(depots.id, routes.depotId))
      .leftJoin(drivers, eq(drivers.id, routes.driverId))
      .where(eq(routes.id, routeId)),
    db
      .select(plannerOrderColumns)
      .from(routeStops)
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .where(eq(routeStops.routeId, routeId))
      .orderBy(asc(routeStops.sequence)) as Promise<PlannerOrderRow[]>,
  ]);
  if (!row) throw notFound('Route not found');
  assertEditable(row.route);
  const { route, depot, driver } = row;

  const located = stops.filter(hasGeo);
  if (located.length < 2) return { skipped: [], changed: false };

  const depotPoint = { lat: depot.lat, lng: depot.lng };
  const end = endPoint(route.endType, depotPoint, driver ? { lat: driver.homeLat, lng: driver.homeLng } : null);
  const startTime = londonToUtc(route.date, driver?.workStart ?? DEFAULT_WORK_START);
  const current = located.map((o) => o.id);
  const result = await routing.optimise(
    {
      shipments: located.map((o) => ({
        orderId: o.id,
        location: { lat: o.lat, lng: o.lng },
        serviceSeconds: (o.serviceMinutes + o.extraMinutes) * 60,
        demand: o.loadUnits,
        window: windowOf(route.date, o.timeWindowStart, o.timeWindowEnd),
      })),
      vehicles: [
        {
          key: 'route',
          start: depotPoint,
          end,
          // Re-ordering the same stops can't change the load or make the day fit, so neither
          // may drop stops here. Overtime still shows as a route warning, from real times.
          capacity: null,
          startTime,
          endTime: new Date(startTime.getTime() + 24 * 3_600_000),
          maxDurationSeconds: null,
        },
      ],
    },
    { initial: [current] },
  );

  // Never drop stops: anything the optimiser couldn't fit keeps its place at the end.
  const proposed = result.routes[0]?.visits.map((v) => v.orderId) ?? [];
  const candidate = [...proposed, ...current.filter((id) => !proposed.includes(id))];
  const byId = new Map(stops.map((s) => [s.id, s]));
  const skipped = result.skipped.map((s) => ({
    orderId: s.orderId,
    orderNumber: byId.get(s.orderId)?.orderNumber ?? '',
    reason: `${SKIP_REASON_TEXT[s.reason]} – kept at the end of the route`,
  }));

  let better = candidate.join() !== current.join();
  if (better) {
    const asRows = (ids: string[]) => ids.map((id) => byId.get(id) as PlannerOrderRow & { lat: number; lng: number });
    let [now, next] = await Promise.all([
      judgeOrder(routing, startTime, depotPoint, end, asRows(current), route.date),
      judgeOrder(routing, startTime, depotPoint, end, asRows(candidate), route.date),
    ]);
    if (now.engine !== next.engine) {
      // One Routes API call failed: compare like with like.
      const estimateOnly = { ...routing, legs: async (points: LatLng[]) => estimateLegs(points) };
      [now, next] = await Promise.all([
        judgeOrder(estimateOnly, startTime, depotPoint, end, asRows(current), route.date),
        judgeOrder(estimateOnly, startTime, depotPoint, end, asRows(candidate), route.date),
      ]);
    }
    // Ignore "improvements" under a minute: not worth reshuffling the driver's list.
    better = next.late < now.late || (next.late === now.late && next.cost < now.cost - 60);
  }

  if (better) {
    const unlocated = stops.filter((s) => !hasGeo(s)).map((s) => s.id);
    await setRouteStops(ctx, routeId, [...candidate, ...unlocated], actor);
  }
  await db.update(routes).set({ optimisedAt: new Date() }).where(eq(routes.id, routeId));
  return { skipped: better ? skipped : [], changed: better };
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
      await Promise.all([
        insertEvents(
          tx,
          stopOrders.map(({ orderId }) =>
            eventRow(actor, orderId, 'route_reassigned', routeId, {
              route: route.name,
              ...(driverChanged && { driver: driverName }),
              ...(vanChanged && { vanId: input.vanId }),
            }),
          ),
        ),
        audit(tx, actor, 'route_reassigned', routeId, { driverId: input.driverId, vanId: input.vanId }),
      ]);
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
    const [stops, [van]] = await Promise.all([
      tx
        .select({ orderId: routeStops.orderId, lat: orders.lat, number: orders.orderNumber, loadUnits, loadKg, loadM3 })
        .from(routeStops)
        .innerJoin(orders, eq(orders.id, routeStops.orderId))
        .where(eq(routeStops.routeId, routeId)),
      tx.select().from(vans).where(eq(vans.id, route.vanId)),
    ]);
    if (!van?.active) throw conflict('VAN_INACTIVE', `${van?.name ?? 'The van'} is off the road. Choose another van before releasing.`);
    if (stops.length === 0) throw conflict('ROUTE_INCOMPLETE', 'Add at least one stop before releasing');
    const noGeo = stops.filter((s) => s.lat === null);
    if (noGeo.length) {
      throw conflict('ROUTE_INCOMPLETE', `These stops have no map location: ${noGeo.map((s) => s.number).join(', ')}`);
    }
    // RTE-08 hard rule: an overloaded van can't physically take the route. Drafts may be
    // over while the planner moves stops around; release is where it has to fit.
    const overload = overCapacity(van, {
      units: stops.reduce((n, s) => n + s.loadUnits, 0),
      kg: stops.reduce((n, s) => n + s.loadKg, 0),
      m3: stops.reduce((n, s) => n + s.loadM3, 0),
    });
    if (overload.length) {
      throw conflict('OVER_CAPACITY', `${route.name} is over ${van?.name ?? 'the van'}'s capacity (${overload.join(', ')}). Move some stops to another route first.`);
    }
    await Promise.all([
      tx.update(routes).set({ status: 'released', releasedAt: new Date(), changedAt: null }).where(eq(routes.id, routeId)),
      insertEvents(
        tx,
        stops.map((s) => eventRow(actor, s.orderId, 'route_released', routeId, { route: route.name })),
      ),
      audit(tx, actor, 'route_released', routeId, { stops: stops.length }),
    ]);
  });
}

export async function unreleaseRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    if (route.status !== 'released') throw conflict('INVALID_ROUTE_STATE', `Only released routes can be moved back to draft`);
    const [stopOrders] = await Promise.all([
      tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, routeId)),
      tx.update(routes).set({ status: 'draft', releasedAt: null, changedAt: new Date() }).where(eq(routes.id, routeId)),
      audit(tx, actor, 'route_unreleased', routeId, {}),
    ]);
    await insertEvents(
      tx,
      stopOrders.map(({ orderId }) => eventRow(actor, orderId, 'route_unreleased', routeId, { route: route.name })),
    );
  });
}

export async function deleteRoute(ctx: PlanningContext, routeId: string, actor: AuthUser): Promise<void> {
  await ctx.db.transaction(async (tx) => removeRoute(tx, await lockRoute(tx, routeId), actor));
}

/** deleteRoute() on a route the caller has already locked: its orders go back to be planned again. */
async function removeRoute(tx: Tx, route: RouteRow, actor: AuthUser, reason?: string): Promise<void> {
  assertEditable(route);
  const stopOrders = await tx.select({ orderId: routeStops.orderId }).from(routeStops).where(eq(routeStops.routeId, route.id));
  await revertFromRoute(
    tx,
    stopOrders.map((s) => s.orderId),
    actor,
    route.name,
  );
  await tx.delete(routes).where(eq(routes.id, route.id));
  await audit(tx, actor, 'route_deleted', route.id, { name: route.name, date: route.date, status: route.status, ...(reason && { reason }) });
}

// ---------- van off the road (DRV-02) ----------

/** Route states that still need their van. */
const NEEDS_VAN: RouteStatus[] = ['draft', 'released', 'in_progress'];

const sumLoad = (stops: { loadUnits: number; loadKg: number; loadM3: number }[]) => ({
  units: stops.reduce((n, s) => n + s.loadUnits, 0),
  kg: stops.reduce((n, s) => n + s.loadKg, 0),
  m3: stops.reduce((n, s) => n + s.loadM3, 0),
});

const vanRouteColumns = { route: routes, driverName: users.name };
const selectRoutesWithDriver = (db: DbOrTx) =>
  db.select(vanRouteColumns).from(routes).leftJoin(drivers, eq(drivers.id, routes.driverId)).leftJoin(users, eq(users.id, drivers.userId));

/** Routes today or later that use the van; what deactivating it would affect. */
const usingVan = (vanId: string, today: string) => and(eq(routes.vanId, vanId), inArray(routes.status, NEEDS_VAN), gte(routes.date, today))!;

/** Stops still to do on each route, with their load. */
async function outstandingStops(db: DbOrTx, routeIds: string[]) {
  if (routeIds.length === 0) return [];
  return db
    .select({ routeId: routeStops.routeId, orderId: routeStops.orderId, loadUnits, loadKg, loadM3 })
    .from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(and(inArray(routeStops.routeId, routeIds), isNull(routeStops.completedAt)))
    .orderBy(asc(routeStops.sequence));
}

/**
 * DRV-02: what taking a van off the road would affect, with the options for each
 * route (spare vans that day, other routes its stops could move to).
 */
export async function getVanImpact(db: Db, vanId: string, today: string): Promise<VanImpact> {
  const [van] = await db.select({ id: vans.id }).from(vans).where(eq(vans.id, vanId));
  if (!van) throw notFound('Van not found');
  const affected = await selectRoutesWithDriver(db).where(usingVan(vanId, today)).orderBy(asc(routes.date), asc(routes.name));
  if (affected.length === 0) return { vanId, routes: [] };

  const ids = affected.map((a) => a.route.id);
  const dates = [...new Set(affected.map((a) => a.route.date))];
  const [totals, open, sameDays, spare] = await Promise.all([
    db
      .select({ routeId: routeStops.routeId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(routeStops)
      .where(inArray(routeStops.routeId, ids))
      .groupBy(routeStops.routeId),
    outstandingStops(db, ids),
    selectRoutesWithDriver(db).where(inArray(routes.date, dates)).orderBy(asc(routes.name)),
    db
      .select()
      .from(vans)
      .where(and(eq(vans.active, true), ne(vans.id, vanId)))
      .orderBy(asc(vans.name)),
  ]);

  return {
    vanId,
    routes: affected.map(({ route: r, driverName }) => {
      const stops = open.filter((s) => s.routeId === r.id);
      const load = sumLoad(stops);
      const sameDay = sameDays.filter((d) => d.route.date === r.date);
      const usedVans = new Set(sameDay.map((d) => d.route.vanId));
      return {
        id: r.id,
        name: r.name,
        date: r.date,
        status: r.status,
        driverName,
        stopsTotal: totals.find((t) => t.routeId === r.id)?.n ?? 0,
        stopsOutstanding: stops.length,
        loadUnits: load.units,
        spareVans: spare
          .filter((v) => !usedVans.has(v.id))
          .map((v) => ({ id: v.id, name: v.name, registration: v.registration, capacityUnits: v.capacityUnits, fits: overCapacity(v, load).length === 0 })),
        transferTargets: sameDay
          .filter(
            ({ route: t }) =>
              t.id !== r.id &&
              t.vanId !== vanId &&
              t.status !== 'completed' &&
              // Stops already out for delivery can't go onto a draft the driver can't see.
              (r.status !== 'in_progress' || t.status !== 'draft'),
          )
          .map(({ route: t, driverName: tDriver }) => ({ id: t.id, name: t.name, status: t.status, driverName: tDriver })),
      };
    }),
  };
}

/**
 * DRV-02: take a van off the road (breakdown, MOT, repairs). Every route that
 * still needs it gets the planner's decision, all in one transaction, then the
 * van is deactivated so it isn't offered for planning until reactivated.
 */
export async function takeVanOffRoad(
  ctx: PlanningContext,
  vanId: string,
  input: VanDeactivateInput,
  actor: AuthUser,
  today: string,
): Promise<void> {
  const reason = input.reason ?? null;
  const note = reason ? `Van off the road: ${reason}` : 'Van off the road';
  const toRecalculate = new Set<string>();

  await ctx.db.transaction(async (tx) => {
    const [van] = await tx.select().from(vans).where(eq(vans.id, vanId)).for('update');
    if (!van) throw notFound('Van not found');
    if (!van.active) throw conflict('VAN_INACTIVE', `${van.name} is already off the road`);

    // Lock the van's routes and every transfer target together, in id order (no deadlocks).
    const affectedIds = (await tx.select({ id: routes.id }).from(routes).where(usingVan(vanId, today))).map((r) => r.id);
    const targetIds = input.routes.flatMap((d) => (d.action === 'transfer' ? [d.toRouteId] : []));
    const lockIds = [...new Set([...affectedIds, ...targetIds])];
    const locked = lockIds.length
      ? await tx.select().from(routes).where(inArray(routes.id, lockIds)).orderBy(asc(routes.id)).for('update')
      : [];
    const byId = new Map(locked.map((r) => [r.id, r]));
    const affected = affectedIds.map((id) => byId.get(id)).filter((r): r is RouteRow => !!r && r.vanId === vanId && NEEDS_VAN.includes(r.status));

    const decided = new Set(input.routes.map((d) => d.routeId));
    if (affected.length !== input.routes.length || affected.some((r) => !decided.has(r.id))) {
      throw conflict('PLAN_OUTDATED', `${van.name}'s routes changed while you were deciding. Review them again.`);
    }

    // Replacement vans: active, not this one, free that day, and each used once per day.
    const swaps = input.routes.flatMap((d) => (d.action === 'swap' ? [{ ...d, route: byId.get(d.routeId)! }] : []));
    const swapVanIds = [...new Set(swaps.map((s) => s.vanId))];
    const [replacements, clashes, open] = await Promise.all([
      swapVanIds.length ? tx.select().from(vans).where(inArray(vans.id, swapVanIds)) : [],
      swapVanIds.length
        ? tx
            .select({ id: routes.id, name: routes.name, date: routes.date, vanId: routes.vanId })
            .from(routes)
            .where(and(inArray(routes.vanId, swapVanIds), inArray(routes.date, [...new Set(swaps.map((s) => s.route.date))])))
        : [],
      outstandingStops(tx, affected.map((r) => r.id)),
    ]);
    const seen = new Set<string>();
    for (const s of swaps) {
      const v = replacements.find((x) => x.id === s.vanId);
      if (!v?.active || v.id === vanId) throw badRequest(`Choose an active replacement van for ${s.route.name}`);
      const clash = clashes.find((c) => c.vanId === v.id && c.date === s.route.date && c.id !== s.route.id);
      if (clash) throw conflict('VAN_BUSY', `${v.name} is already used by ${clash.name} on ${s.route.date}`);
      const key = `${v.id}|${s.route.date}`;
      if (seen.has(key)) throw conflict('VAN_BUSY', `${v.name} can only replace one route on ${s.route.date}`);
      seen.add(key);
      // Released and started routes are loaded for real: the replacement must take it.
      if (s.route.status !== 'draft') {
        const over = overCapacity(v, sumLoad(open.filter((o) => o.routeId === s.route.id)));
        if (over.length) {
          throw conflict('OVER_CAPACITY', `${s.route.name} won't fit in ${v.name} (${over.join(', ')}). Choose a bigger van or move its stops to another route.`);
        }
      }
    }

    for (const d of input.routes) {
      const r = byId.get(d.routeId)!;
      const openIds = open.filter((o) => o.routeId === r.id).map((o) => o.orderId);
      const onTheRoad = r.status === 'in_progress';

      if (d.action === 'swap') {
        const v = replacements.find((x) => x.id === d.vanId)!;
        await Promise.all([
          tx
            .update(routes)
            .set({ vanId: v.id, ...(r.status !== 'draft' && { changedAt: new Date() }) })
            .where(eq(routes.id, r.id)),
          insertEvents(
            tx,
            openIds.map((orderId) => eventRow(actor, orderId, 'route_reassigned', r.id, { route: r.name, vanId: v.id, van: v.name, reason: note })),
          ),
          audit(tx, actor, 'route_reassigned', r.id, { vanId: v.id, fromVanId: vanId, reason }),
        ]);
      } else if (d.action === 'unassign') {
        if (onTheRoad) throw conflict('ROUTE_STARTED', `${r.name} is already on the road: swap its van or move its stops instead`);
        const unrelease = r.status === 'released';
        await Promise.all([
          tx
            .update(routes)
            .set({ vanId: null, ...(unrelease && { status: 'draft' as const, releasedAt: null, changedAt: new Date() }) })
            .where(eq(routes.id, r.id)),
          unrelease &&
            insertEvents(
              tx,
              openIds.map((orderId) => eventRow(actor, orderId, 'route_unreleased', r.id, { route: r.name, reason: note })),
            ),
          audit(tx, actor, unrelease ? 'route_unreleased' : 'route_reassigned', r.id, { vanId: null, fromVanId: vanId, reason }),
        ]);
      } else if (d.action === 'unplan') {
        if (onTheRoad) throw conflict('ROUTE_STARTED', `${r.name} is already on the road: swap its van or move its stops instead`);
        await removeRoute(tx, r, actor, note);
      } else {
        const to = byId.get(d.toRouteId);
        if (!to || to.id === r.id) throw badRequest(`Choose another route for ${r.name}'s stops`);
        if (to.vanId === vanId) throw conflict('VAN_BUSY', `${to.name} uses the same van – choose another route for ${r.name}'s stops`);
        if (openIds.length) await moveStops(tx, r, to, openIds, actor, note);
        toRecalculate.add(to.id);
        if (onTheRoad) {
          // Its completed stops stay on it as the record of what this van delivered.
          toRecalculate.add(r.id);
        } else {
          // Nothing left on a route that never started: remove it.
          await removeRoute(tx, r, actor, note);
        }
      }
    }

    await Promise.all([
      tx.update(vans).set({ active: false }).where(eq(vans.id, vanId)),
      tx.insert(auditLog).values({
        actorId: actor.id,
        action: 'van_deactivated',
        entity: 'van',
        entityId: vanId,
        details: { reason, routes: input.routes },
      }),
    ]);
  });

  await Promise.all([...toRecalculate].map((id) => recalculateRoute(ctx, id)));
}

/** Thrown for "can't optimise twice at once" etc. */
export const busy = (message: string) => new AppError(409, 'BUSY', message);
