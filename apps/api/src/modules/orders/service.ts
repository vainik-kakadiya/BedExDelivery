import {
  type Db,
  type DbOrTx,
  type Tx,
  deliveryAttempts,
  orderEvents,
  orderItems,
  orders,
  routeStops,
  routes,
  users,
} from '@bedex/db';
import {
  DELETABLE_ORDER_STATUSES,
  ORDER_STATUS_META,
  type OrderCreateInput,
  type OrderDeleteInput,
  type OrderDeleteResult,
  type OrderListItem,
  type OrderHistory,
  type OrderListQuery,
  type OrderStatus,
  type OrderStatusChangeInput,
  type OrderUpdateInput,
  type Paginated,
  checkTransition,
  generateTrackingRef,
  isFinalStatus,
  normaliseTrackingRef,
  orderRuleIssues,
  postcodeKey,
} from '@bedex/shared';
import { type SQL, and, asc, desc, eq, ilike, inArray, like, lt, or, sql } from 'drizzle-orm';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import type { PhotoStorage } from '../../lib/storage';

export type OrderRow = typeof orders.$inferSelect;
type OrderPatch = Partial<typeof orders.$inferInsert>;

/** Moving into any of these statuses detaches the order from its current route. */
const LEAVES_ROUTE: readonly OrderStatus[] = [
  'awaiting_scheduling',
  'in_warehouse',
  'rescheduled',
  'returned_to_warehouse',
  'cancelled',
];
/** Items can change only while the goods haven't left the depot. */
const ITEMS_EDITABLE: readonly OrderStatus[] = [
  'awaiting_scheduling',
  'in_warehouse',
  'scheduled',
  'rescheduled',
  'returned_to_warehouse',
];

// ---------- create ----------

export async function createOrder(db: Db, input: OrderCreateInput, actor: AuthUser): Promise<OrderRow> {
  const { items, ...fields } = input;
  return db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({ ...fields, trackingRef: await uniqueTrackingRef(tx), source: 'manual', createdBy: actor.id })
      .returning();
    if (!order) throw new Error('Order insert returned no row');

    await tx.insert(orderItems).values(
      items.map((i) => ({
        orderId: order.id,
        sku: i.sku ?? null,
        name: i.name,
        qty: i.qty,
        units: i.units,
        weightKg: i.weightKg ?? null,
        volumeM3: i.volumeM3 ?? null,
      })),
    );
    await tx.insert(orderEvents).values({
      orderId: order.id,
      actorId: actor.id,
      actorRole: actor.role,
      type: 'created',
      toStatus: order.status,
      payload: { source: 'manual' },
    });
    // TODO(ORD-07): enqueue geocoding job here.
    return order;
  });
}

async function uniqueTrackingRef(tx: DbOrTx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = generateTrackingRef();
    const hit = await tx.select({ id: orders.id }).from(orders).where(eq(orders.trackingRef, ref)).limit(1);
    if (hit.length === 0) return ref;
  }
  throw new Error('Could not generate a unique tracking reference');
}

// ---------- read ----------

export async function getOrder(db: Db, id: string) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: { items: { orderBy: (i, { asc }) => [asc(i.name)] } },
  });
  if (!order) throw notFound('Order not found');
  return order;
}

/** How long the office's photo links stay valid. The page refetches before they expire. */
const PHOTO_LINK_SECONDS = 15 * 60;

/**
 * HST-01 – HST-03: what happened to an order — the route it's on, every delivery
 * attempt (driver, recipient, proof photos as short-lived links) and the event log.
 */
export async function getOrderHistory(db: Db, id: string, storage: PhotoStorage | null): Promise<OrderHistory> {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { id: true, currentRouteId: true } });
  if (!order) throw notFound('Order not found');

  const [events, attempts, route] = await Promise.all([
    db
      .select({
        id: orderEvents.id,
        type: orderEvents.type,
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        note: orderEvents.note,
        payload: orderEvents.payload,
        routeId: orderEvents.routeId,
        createdAt: orderEvents.createdAt,
        actorId: orderEvents.actorId,
        actorName: users.name,
        actorRole: orderEvents.actorRole,
      })
      .from(orderEvents)
      .leftJoin(users, eq(users.id, orderEvents.actorId))
      .where(eq(orderEvents.orderId, id))
      .orderBy(asc(orderEvents.createdAt)),
    db.query.deliveryAttempts.findMany({
      where: eq(deliveryAttempts.orderId, id),
      orderBy: (a, { desc }) => [desc(a.attemptNo)],
      with: {
        photos: { orderBy: (p, { asc }) => [asc(p.createdAt)] },
        driver: { columns: {}, with: { user: { columns: { name: true } } } },
        route: { columns: { name: true, date: true } },
      },
    }),
    order.currentRouteId
      ? db.query.routes.findFirst({
          where: eq(routes.id, order.currentRouteId),
          columns: { id: true, name: true, date: true, status: true },
          with: {
            driver: { columns: {}, with: { user: { columns: { name: true } } } },
            van: { columns: { name: true, registration: true } },
          },
        })
      : undefined,
  ]);

  // A missing file or storage outage shouldn't hide the rest of the history.
  const link = async (path: string) => {
    if (!storage) return null;
    try {
      return await storage.signedUrl(path, PHOTO_LINK_SECONDS);
    } catch {
      return null;
    }
  };

  return {
    route: route
      ? {
          id: route.id,
          name: route.name,
          date: route.date,
          status: route.status,
          driverName: route.driver?.user.name ?? null,
          vanName: route.van?.name ?? null,
          vanRegistration: route.van?.registration ?? null,
        }
      : null,
    attempts: await Promise.all(
      attempts.map(async (a) => ({
        id: a.id,
        attemptNo: a.attemptNo,
        outcome: a.outcome,
        failureReason: a.failureReason,
        recipientName: a.recipientName,
        leftAtType: a.leftAtType,
        leftAtNote: a.leftAtNote,
        notes: a.notes,
        occurredAt: a.occurredAt.toISOString(),
        driverName: a.driver?.user.name ?? null,
        routeName: a.route?.name ?? null,
        routeDate: a.route?.date ?? null,
        photos: await Promise.all(
          a.photos.map(async (p) => ({ id: p.id, type: p.type, url: await link(p.storagePath), takenAt: p.takenAt?.toISOString() ?? null })),
        ),
      })),
    ),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
      actorName: e.actorName,
      actorRole: e.actorRole,
    })),
  };
}

export type OrderFilters = Omit<OrderListQuery, 'cursor' | 'limit'>;

/** ORD-04 / DSH-05 filters, shared by the order list and the order export. */
export function orderFilterConditions(db: Db, query: OrderFilters): SQL[] {
  const conditions: SQL[] = [];
  if (query.q) conditions.push(searchCondition(query.q));
  if (query.status?.length) conditions.push(inArray(orders.status, query.status));
  if (query.date) conditions.push(eq(orders.scheduledDate, query.date));
  if (query.routeId) conditions.push(eq(orders.currentRouteId, query.routeId));
  if (query.driverId) {
    conditions.push(
      inArray(orders.currentRouteId, db.select({ id: routes.id }).from(routes).where(eq(routes.driverId, query.driverId))),
    );
  }
  if (query.postcodePrefix) conditions.push(ilike(orders.postcode, `${escapeLike(query.postcodePrefix.toUpperCase())}%`));
  if (query.source) conditions.push(eq(orders.source, query.source));
  return conditions;
}

export async function listOrders(db: Db, query: OrderListQuery): Promise<Paginated<OrderListItem>> {
  const conditions = orderFilterConditions(db, query);
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    conditions.push(or(lt(orders.createdAt, c.createdAt), and(eq(orders.createdAt, c.createdAt), lt(orders.id, c.id)))!);
  }

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      trackingRef: orders.trackingRef,
      customerName: orders.customerName,
      town: orders.town,
      postcode: orders.postcode,
      status: orders.status,
      scheduledDate: orders.scheduledDate,
      currentRouteId: orders.currentRouteId,
      source: orders.source,
      geocodeStatus: orders.geocodeStatus,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/** ORD-03: order number, tracking ref, name, address, postcode, phone. */
function searchCondition(raw: string): SQL {
  const term = raw.trim();
  const contains = `%${escapeLike(term)}%`;
  const parts: SQL[] = [
    ilike(orders.orderNumber, contains),
    eq(orders.trackingRef, normaliseTrackingRef(term)),
    ilike(orders.customerName, contains),
    ilike(orders.addressLine1, contains),
    ilike(sql`replace(${orders.postcode}, ' ', '')`, `%${escapeLike(postcodeKey(term))}%`),
  ];
  // Phones are stored as +44…; match on the national digits.
  if (/^[\d\s+()-]+$/.test(term)) {
    const digits = term.replace(/\D/g, '').replace(/^0+/, '').replace(/^44/, '');
    if (digits.length >= 5) parts.push(like(orders.customerPhone, `%${digits}%`));
  }
  return or(...parts)!;
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw badRequest('Invalid cursor');
  return { createdAt, id };
}

// ---------- update ----------

export async function updateOrder(db: Db, id: string, input: OrderUpdateInput, actor: AuthUser): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    const existing = await lockOrder(tx, id);
    if (isFinalStatus(existing.status) && actor.role !== 'admin') {
      throw conflict('ORDER_LOCKED', `"${ORDER_STATUS_META[existing.status].label}" orders can only be edited by an admin`);
    }

    const { items, ...fields } = input;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const before = existing[key as keyof OrderRow];
      if (normaliseForDiff(before) !== normaliseForDiff(value)) {
        changes[key] = { from: before, to: value };
        patch[key] = value;
      }
    }

    const merged = { ...existing, ...patch } as OrderRow;
    const ruleIssues = orderRuleIssues(merged);
    if (ruleIssues.length) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', {
        fieldErrors: Object.fromEntries(ruleIssues.map((i) => [i.path, [i.message]])),
      });
    }

    if (['addressLine1', 'addressLine2', 'town', 'postcode'].some((k) => k in changes)) {
      Object.assign(patch, { lat: null, lng: null, geocodeStatus: 'pending' });
      // TODO(ORD-07): enqueue re-geocoding.
    }

    if (items) {
      if (!ITEMS_EDITABLE.includes(existing.status)) {
        throw conflict('ITEMS_LOCKED', 'Items cannot be changed once the order is out for delivery');
      }
      const before = await tx
        .select({ name: orderItems.name, qty: orderItems.qty })
        .from(orderItems)
        .where(eq(orderItems.orderId, id));
      await tx.delete(orderItems).where(eq(orderItems.orderId, id));
      await tx.insert(orderItems).values(
        items.map((i) => ({
          orderId: id,
          sku: i.sku ?? null,
          name: i.name,
          qty: i.qty,
          units: i.units,
          weightKg: i.weightKg ?? null,
          volumeM3: i.volumeM3 ?? null,
        })),
      );
      changes.items = { from: before, to: items.map((i) => ({ name: i.name, qty: i.qty })) };
    }

    if (Object.keys(changes).length === 0) return existing;

    const [updated] = await tx
      .update(orders)
      .set(patch as OrderPatch)
      .where(eq(orders.id, id))
      .returning();
    await tx.insert(orderEvents).values({
      orderId: id,
      actorId: actor.id,
      actorRole: actor.role,
      type: 'updated',
      payload: { changes },
    });
    return updated ?? existing;
  });
}

/** Postgres returns times as "HH:MM:SS"; inputs are "HH:MM". */
function normaliseForDiff(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && /^\d{2}:\d{2}:00$/.test(v)) return v.slice(0, 5);
  return v;
}

// ---------- status ----------

export async function changeOrderStatus(db: Db, id: string, input: OrderStatusChangeInput, actor: AuthUser) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    return transitionOrder(tx, order, input.to, actor, {
      reason: input.reason,
      note: input.note,
      scheduledDate: input.scheduledDate,
    });
  });
}

export interface TransitionOptions {
  reason?: string | null;
  note?: string | null;
  scheduledDate?: string | null;
  routeId?: string | null;
  payload?: Record<string, unknown>;
  /** Extra columns to set in the same update (e.g. the route an order is planned onto). */
  patch?: OrderPatch;
}

/**
 * The single path for every order status change (office, planner, driver):
 * enforces the §6 machine, keeps route links consistent and writes history (HST-01).
 */
export async function transitionOrder(
  tx: Tx,
  order: OrderRow,
  to: OrderStatus,
  actor: AuthUser,
  opts: TransitionOptions = {},
): Promise<OrderRow> {
  const check = checkTransition(order.status, to, actor.role);
  if (!check.ok) throw conflict('INVALID_TRANSITION', check.reason, { from: order.status, to });

  const patch: OrderPatch = { ...opts.patch, status: to };
  if (to === 'cancelled') patch.cancelReason = opts.reason ?? null;
  if (check.reopen) patch.cancelReason = null;
  if (to === 'awaiting_scheduling') patch.scheduledDate = null;
  if (to === 'rescheduled') patch.scheduledDate = opts.scheduledDate ?? null;

  if (LEAVES_ROUTE.includes(to) && order.currentRouteId) {
    const [route] = await tx
      .select({ status: routes.status })
      .from(routes)
      .where(eq(routes.id, order.currentRouteId));
    // Unstarted routes lose the stop; started/completed routes keep it as a record of what happened.
    if (route && (route.status === 'draft' || route.status === 'released')) {
      await tx
        .delete(routeStops)
        .where(and(eq(routeStops.routeId, order.currentRouteId), eq(routeStops.orderId, order.id)));
      // TODO(RTE-09): notify the driver when a released route changes.
    }
    patch.currentRouteId = null;
  }

  const [updated] = await tx.update(orders).set(patch).where(eq(orders.id, order.id)).returning();
  if (!updated) throw notFound('Order not found');

  await tx.insert(orderEvents).values({
    orderId: order.id,
    actorId: actor.id,
    actorRole: actor.role,
    type: check.reopen ? 'reopened' : 'status_changed',
    fromStatus: order.status,
    toStatus: to,
    routeId: opts.routeId ?? order.currentRouteId,
    driverId: actor.driverId,
    note: opts.note ?? null,
    payload: {
      ...(opts.reason && { reason: opts.reason }),
      ...(opts.scheduledDate && { scheduledDate: opts.scheduledDate }),
      ...opts.payload,
    },
  });
  return updated;
}

export async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
  if (!order) throw notFound('Order not found');
  return order;
}

// ---------- delete ----------

/**
 * Delete orders created by mistake. Only orders that never got near a delivery
 * qualify (DELETABLE_ORDER_STATUSES, never on a route, no attempts); the rest
 * are skipped with a reason so the office can cancel them instead.
 * Items, history events and issues go with the order (ON DELETE CASCADE).
 */
export async function deleteOrders(db: Db, input: OrderDeleteInput): Promise<OrderDeleteResult & { deletedOrders: { id: string; orderNumber: string }[] }> {
  const ids = [...new Set(input.ids)];
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, currentRouteId: orders.currentRouteId })
      .from(orders)
      .where(inArray(orders.id, ids))
      .for('update');
    const [onRoutes, attempted] = await Promise.all([
      tx.selectDistinct({ orderId: routeStops.orderId }).from(routeStops).where(inArray(routeStops.orderId, ids)),
      tx.selectDistinct({ orderId: deliveryAttempts.orderId }).from(deliveryAttempts).where(inArray(deliveryAttempts.orderId, ids)),
    ]);
    const routeSet = new Set(onRoutes.map((r) => r.orderId));
    const attemptSet = new Set(attempted.map((r) => r.orderId));

    const skipped: OrderDeleteResult['skipped'] = [];
    const deletable: { id: string; orderNumber: string }[] = [];
    for (const o of found) {
      let reason: string | null = null;
      if (!DELETABLE_ORDER_STATUSES.includes(o.status)) {
        reason = `It is "${ORDER_STATUS_META[o.status].label}". Cancel it instead.`;
      } else if (attemptSet.has(o.id)) {
        reason = 'It has a delivery attempt on record. Cancel it instead.';
      } else if (routeSet.has(o.id) || o.currentRouteId) {
        reason = 'It is (or was) on a route. Take it off the route or cancel it instead.';
      }
      if (reason) skipped.push({ id: o.id, orderNumber: o.orderNumber, reason });
      else deletable.push({ id: o.id, orderNumber: o.orderNumber });
    }

    if (deletable.length) await tx.delete(orders).where(inArray(orders.id, deletable.map((o) => o.id)));
    return { deleted: deletable.length, skipped, deletedOrders: deletable };
  });
}
