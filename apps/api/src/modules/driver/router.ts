import { routes } from '@bedex/db';
import { toLondonDate } from '@bedex/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { changeStream } from '../../lib/sse';
import { currentDriverId, requireAuth, requireRole } from '../../middleware/auth';

/**
 * The only order fields a driver ever receives. Internal notes, order source,
 * customer email etc. are deliberately absent (PRD §2, §9).
 */
export const DRIVER_ORDER_COLUMNS = {
  id: true,
  orderNumber: true,
  status: true,
  customerName: true,
  customerPhone: true,
  addressLine1: true,
  addressLine2: true,
  town: true,
  postcode: true,
  lat: true,
  lng: true,
  timeWindowStart: true,
  timeWindowEnd: true,
  accessInstructions: true,
  deliveryNotes: true,
  requiresSignature: true,
} as const;

export function driverRouter({ db, env, changes }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('driver'));

  // DRP-02: today's released routes for *this* driver only.
  router.get('/routes/today', async (req, res) => {
    const driverId = currentDriverId(req);
    const today = toLondonDate();
    const rows = await db.query.routes.findMany({
      where: and(
        eq(routes.driverId, driverId),
        eq(routes.date, today),
        inArray(routes.status, ['released', 'in_progress', 'completed']),
      ),
      columns: {
        id: true,
        date: true,
        name: true,
        status: true,
        totalMiles: true,
        totalMinutes: true,
        startedAt: true,
        releasedAt: true,
        // RTE-09: set when the office edits a released route; the app highlights it.
        changedAt: true,
      },
      orderBy: (r, { asc }) => [asc(r.createdAt)],
      with: {
        stops: {
          orderBy: (s, { asc }) => [asc(s.sequence)],
          columns: { id: true, sequence: true, eta: true, arrivedAt: true, completedAt: true },
          with: {
            order: {
              columns: DRIVER_ORDER_COLUMNS,
              with: { items: { columns: { id: true, sku: true, name: true, qty: true, deliveredQty: true } } },
            },
          },
        },
      },
    });
    res.json({ date: today, routes: rows });
  });

  // RTE-09 / DRV-05: tell the app to refetch when routes change. Events carry
  // table names only; the refetch above is what enforces driver scoping.
  router.get('/stream', changeStream(changes, ['routes', 'route_stops', 'orders']));

  // TODO(weeks 4–5): POST /routes/:id/start, /stops/:id/complete, /uploads, /location —
  // each must re-check that the route/stop belongs to currentDriverId(req).

  return router;
}
