import { orderEvents, orders } from '@bedex/db';
import { normaliseTrackingRef, postcodesMatch, trackQuerySchema } from '@bedex/shared';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { limiter } from '../../middleware/rateLimit';
import { toPublicTracking } from './tracking';

/** Same response for bad input, unknown ref and wrong postcode (TRK-05). */
const notFoundGeneric = () =>
  new AppError(404, 'NOT_FOUND', "We couldn't find a delivery matching that tracking number and postcode.");

export function publicRouter({ db }: AppContext) {
  const router = Router();

  router.get('/track', limiter({ windowMs: 60_000, limit: 10 }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = trackQuerySchema.safeParse(req.query);
    if (!parsed.success) throw notFoundGeneric();

    const order = await db.query.orders.findFirst({
      where: eq(orders.trackingRef, normaliseTrackingRef(parsed.data.ref)),
      columns: {
        id: true,
        trackingRef: true,
        postcode: true,
        status: true,
        scheduledDate: true,
        timeWindowStart: true,
        timeWindowEnd: true,
      },
    });
    if (!order || !postcodesMatch(order.postcode, parsed.data.postcode)) throw notFoundGeneric();

    const events = await db
      .select({ toStatus: orderEvents.toStatus, createdAt: orderEvents.createdAt })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), isNotNull(orderEvents.toStatus)))
      .orderBy(asc(orderEvents.createdAt));

    // TODO(TRK-03): proof photo / driver name / live location behind admin settings.
    res.json(toPublicTracking(order, events));
  });

  return router;
}
