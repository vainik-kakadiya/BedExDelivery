import { randomUUID } from 'node:crypto';
import { routes } from '@bedex/db';
import { driverLocationSchema, stopDeliveredSchema, toLondonDate } from '@bedex/shared';
import { and, eq, inArray } from 'drizzle-orm';
import express, { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { changeStream } from '../../lib/sse';
import { currentDriverId, currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { recalculateRoute } from '../planning/service';
import { completeStopDelivered, proofPhotoTarget, recordDriverLocation } from './service';

const stopIdParam = (raw: unknown) => {
  const parsed = z.string().uuid().safeParse(String(raw));
  if (!parsed.success) throw notFound('Stop not found');
  return parsed.data;
};

/** Photos arrive already compressed (DRP-07, ~300 KB); this is a generous ceiling. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Trust the bytes, not the Content-Type header. */
function sniffImage(buf: Buffer): { ext: string; type: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', type: 'image/png' };
  }
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

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

export function driverRouter({ db, env, changes, storage, routing }: AppContext) {
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

  // DRP-05: proof photo for a stop, stored privately in Supabase Storage.
  // Sent as the raw image body; the path it returns goes into /complete.
  router.post(
    '/stops/:stopId/photos',
    express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }),
    async (req, res) => {
      const stopId = stopIdParam(req.params.stopId);
      if (!storage) throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Photo storage is not set up yet. Ask the office to configure it.');
      const prefix = await proofPhotoTarget(db, currentDriverId(req), stopId);
      const body: unknown = req.body;
      const image = Buffer.isBuffer(body) ? sniffImage(body) : null;
      if (!image || !Buffer.isBuffer(body)) throw badRequest('Upload a JPEG, PNG or WebP photo');
      const path = `${prefix}${randomUUID()}.${image.ext}`;
      try {
        await storage.upload(path, body, image.type);
      } catch (err) {
        req.log.error({ err }, 'Photo upload to storage failed');
        throw new AppError(502, 'UPLOAD_FAILED', 'The photo could not be saved. Try again.');
      }
      res.status(201).json({ path });
    },
  );

  // DRP-05: complete a stop as delivered (photo proof, recipient, where it was left).
  router.post('/stops/:stopId/complete', async (req, res) => {
    const stopId = stopIdParam(req.params.stopId);
    const input = stopDeliveredSchema.parse(req.body);
    const result = await completeStopDelivered(db, currentUser(req), stopId, input);
    res.json(result);
    // DSH-03: re-time the stops still to do from here and now, so the office sees
    // a real "last stop" ETA. Best effort: the delivery is already saved.
    if (!result.replayed) {
      void retimeRoute(result.routeId).catch((err: unknown) => req.log.warn({ err, routeId: result.routeId }, 'Could not update ETAs after a delivery'));
    }
  });

  async function retimeRoute(id: string) {
    const [route] = await db.select({ status: routes.status }).from(routes).where(eq(routes.id, id));
    if (route?.status === 'in_progress') await recalculateRoute({ db, routing }, id);
  }

  // DSH-03: GPS from the app while a route is out (sent about every 30 s while it is open).
  router.post('/location', limiter({ windowMs: 60_000, limit: 30 }), async (req, res) => {
    const input = driverLocationSchema.parse(req.body);
    res.json({ tracking: await recordDriverLocation(db, currentDriverId(req), input) });
  });

  // TODO(weeks 4–5): failed / partial outcomes, POST /routes/:id/end —
  // each must re-check that the route/stop belongs to currentDriverId(req).

  return router;
}
