import { routes } from '@bedex/db';
import {
  type RouteOption,
  isoDateSchema,
  optimiseRequestSchema,
  routeStopsSchema,
  routeUpdateSchema,
  stopTransferSchema,
  toLondonDate,
} from '@bedex/shared';
import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { OptimiseJobs } from './jobs';
import {
  type PlanningContext,
  deleteRoute,
  getPlannerState,
  optimiseDay,
  recalculateRoute,
  releaseRoute,
  reoptimiseRoute,
  setRouteStops,
  transferStops,
  unreleaseRoute,
  updateRoute,
} from './service';

const uuid = z.string().uuid();
const routeId = (raw: string | undefined) => {
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw notFound('Route not found');
  return parsed.data;
};
const dateQuery = z.object({ date: isoDateSchema.optional() });

/** RTE-01 – RTE-09 (manifests, RTE-10, live under /exports). */
export function routesRouter({ db, env, routing }: AppContext) {
  const router = Router();
  const ctx: PlanningContext = { db, routing };
  const jobs = new OptimiseJobs();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));

  // Simple list for filters (DSH-05).
  router.get('/', async (req, res) => {
    const date = z.object({ date: isoDateSchema }).parse(req.query).date;
    const rows: RouteOption[] = await db
      .select({ id: routes.id, name: routes.name, date: routes.date, status: routes.status, driverId: routes.driverId })
      .from(routes)
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name));
    res.json(rows);
  });

  router.get('/plan', async (req, res) => {
    const { date } = dateQuery.parse(req.query);
    res.json(await getPlannerState(ctx, date ?? toLondonDate()));
  });

  router.post('/optimise', (req, res) => {
    const input = optimiseRequestSchema.parse(req.body);
    const actor = currentUser(req);
    const job = jobs.start(input.date, (setPhase) => optimiseDay(ctx, input, actor, setPhase));
    res.status(202).json(job);
  });

  router.get('/optimise/:jobId', (req, res) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) throw notFound('Optimisation job not found (it may have expired)');
    res.json(job);
  });

  router.patch('/:id', async (req, res) => {
    await updateRoute(ctx, routeId(req.params.id), routeUpdateSchema.parse(req.body), currentUser(req));
    res.status(204).end();
  });

  router.put('/:id/stops', async (req, res) => {
    const { orderIds } = routeStopsSchema.parse(req.body);
    await setRouteStops(ctx, routeId(req.params.id), orderIds, currentUser(req));
    res.status(204).end();
  });

  // DRV-05: move individual stops (also from routes already on the road).
  router.post('/:id/stops/transfer', async (req, res) => {
    const { orderIds, toRouteId } = stopTransferSchema.parse(req.body);
    await transferStops(ctx, routeId(req.params.id), orderIds, toRouteId, currentUser(req));
    res.status(204).end();
  });

  router.post('/:id/recalculate', async (req, res) => {
    await recalculateRoute(ctx, routeId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/reoptimise', async (req, res) => {
    res.json(await reoptimiseRoute(ctx, routeId(req.params.id), currentUser(req)));
  });

  router.post('/:id/release', async (req, res) => {
    await releaseRoute(ctx, routeId(req.params.id), currentUser(req));
    res.status(204).end();
  });

  router.post('/:id/unrelease', async (req, res) => {
    await unreleaseRoute(ctx, routeId(req.params.id), currentUser(req));
    res.status(204).end();
  });

  router.delete('/:id', async (req, res) => {
    await deleteRoute(ctx, routeId(req.params.id), currentUser(req));
    res.status(204).end();
  });

  return router;
}
