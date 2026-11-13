import { type Db, type Tx, attemptPhotos, deliveryAttempts, orderItems, orders, routeStops, routes } from '@bedex/db';
import type { StopDeliveredInput } from '@bedex/shared';
import { and, eq, max, sql } from 'drizzle-orm';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import { lockOrder, transitionOrder } from '../orders/service';

/** Every proof photo for a stop lives under this prefix; completion rejects paths outside it. */
export const proofPhotoPrefix = (orderId: string, stopId: string) => `orders/${orderId}/${stopId}/`;

const ACTIVE_ROUTE = ['released', 'in_progress'] as const;

interface DriverStopRow {
  id: string;
  orderId: string;
  completedAt: Date | null;
  routeId: string;
  routeStatus: (typeof routes.$inferSelect)['status'];
  driverId: string | null;
}

/**
 * A stop on one of *this* driver's routes, or 404: other drivers' stops are
 * indistinguishable from missing ones (PRD §9).
 */
async function findDriverStop(db: Db | Tx, driverId: string, stopId: string, lock = false): Promise<DriverStopRow> {
  const query = db
    .select({
      id: routeStops.id,
      orderId: routeStops.orderId,
      completedAt: routeStops.completedAt,
      routeId: routes.id,
      routeStatus: routes.status,
      driverId: routes.driverId,
    })
    .from(routeStops)
    .innerJoin(routes, eq(routes.id, routeStops.routeId))
    .where(eq(routeStops.id, stopId));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || row.driverId !== driverId) throw notFound('Stop not found');
  return row;
}

function assertOpen(stop: DriverStopRow) {
  if (stop.completedAt) throw conflict('STOP_COMPLETED', 'This stop has already been completed');
  if (!(ACTIVE_ROUTE as readonly string[]).includes(stop.routeStatus)) {
    throw conflict('ROUTE_NOT_ACTIVE', 'This route is not out for delivery');
  }
}

/** Checks a photo may be added to this stop and returns where it should be stored. */
export async function proofPhotoTarget(db: Db, driverId: string, stopId: string): Promise<string> {
  const stop = await findDriverStop(db, driverId, stopId);
  assertOpen(stop);
  return proofPhotoPrefix(stop.orderId, stop.id);
}

/**
 * DRP-03, implicitly: the first completed stop starts a released route, so every
 * order still "Scheduled" on it goes "Out for delivery".
 */
async function startRoute(tx: Tx, routeId: string, actor: AuthUser) {
  const started = await tx
    .update(routes)
    .set({ status: 'in_progress', startedAt: sql`coalesce(${routes.startedAt}, now())` })
    .where(and(eq(routes.id, routeId), eq(routes.status, 'released')))
    .returning({ id: routes.id });
  if (started.length === 0) return;
  const onRoute = await tx
    .select({ id: orders.id })
    .from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(and(eq(routeStops.routeId, routeId), eq(orders.status, 'scheduled')));
  for (const { id } of onRoute) {
    await transitionOrder(tx, await lockOrder(tx, id), 'out_for_delivery', actor, { routeId });
  }
}

/** DRP-05 "Delivered": one attempt row (HST-02) with its proof photos, then the status change. */
export async function completeStopDelivered(db: Db, actor: AuthUser, stopId: string, input: StopDeliveredInput) {
  const driverId = actor.driverId;
  if (!driverId) throw notFound('Stop not found');

  return db.transaction(async (tx) => {
    const stop = await findDriverStop(tx, driverId, stopId, true);

    // DRP-06: a retry of a request that already succeeded is answered, not repeated.
    const [previous] = await tx
      .select({ id: deliveryAttempts.id, orderId: deliveryAttempts.orderId })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.clientActionId, input.clientActionId));
    if (previous) {
      if (previous.orderId !== stop.orderId) throw conflict('DUPLICATE_ACTION', 'This update was already used for another stop');
      return { attemptId: previous.id, replayed: true };
    }

    assertOpen(stop);

    const prefix = proofPhotoPrefix(stop.orderId, stop.id);
    const paths = input.photos.map((p) => p.path);
    if (paths.some((p) => !p.startsWith(prefix) || p.includes('..')) || new Set(paths).size !== paths.length) {
      throw badRequest('Photos must be uploaded for this stop first');
    }

    if (stop.routeStatus === 'released') await startRoute(tx, stop.routeId, actor);

    let order = await lockOrder(tx, stop.orderId);
    if (order.status === 'scheduled') {
      order = await transitionOrder(tx, order, 'out_for_delivery', actor, { routeId: stop.routeId });
    }

    // A device clock running ahead must not record a delivery in the future.
    const now = new Date();
    const reported = input.occurredAt ? new Date(input.occurredAt) : now;
    const occurredAt = reported > now ? now : reported;

    const [last] = await tx
      .select({ n: max(deliveryAttempts.attemptNo) })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.orderId, order.id));
    const attemptNo = (last?.n ?? 0) + 1;

    const [attempt] = await tx
      .insert(deliveryAttempts)
      .values({
        orderId: order.id,
        routeId: stop.routeId,
        driverId,
        attemptNo,
        outcome: 'delivered',
        recipientName: input.recipientName,
        leftAtType: input.leftAtType,
        leftAtNote: input.leftAtType === 'customer' ? null : (input.leftAtNote ?? null),
        notes: input.notes ?? null,
        clientActionId: input.clientActionId,
        occurredAt,
      })
      .returning({ id: deliveryAttempts.id });
    if (!attempt) throw new Error('Attempt insert failed');

    await tx.insert(attemptPhotos).values(
      input.photos.map((p) => ({
        attemptId: attempt.id,
        storagePath: p.path,
        type: 'proof' as const,
        takenAt: p.takenAt ? new Date(p.takenAt) : null,
      })),
    );
    await tx.update(orderItems).set({ deliveredQty: sql`${orderItems.qty}` }).where(eq(orderItems.orderId, order.id));

    // Throws INVALID_TRANSITION if the office has meanwhile moved the order on (e.g. cancelled it).
    await transitionOrder(tx, order, 'delivered', actor, {
      routeId: stop.routeId,
      payload: { attemptId: attempt.id, attemptNo, photos: paths.length },
    });

    await tx
      .update(routeStops)
      .set({ completedAt: occurredAt, arrivedAt: sql`coalesce(${routeStops.arrivedAt}, ${occurredAt.toISOString()}::timestamptz)` })
      .where(eq(routeStops.id, stop.id));

    return { attemptId: attempt.id, replayed: false };
  });
}
