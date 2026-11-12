import { drivers, routes, users } from '@bedex/db';
import { type DriverOption, type RouteOption, isoDateSchema } from '@bedex/shared';
import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireAuth, requireRole } from '../middleware/auth';

/**
 * Read-only lists for filters and pickers (DSH-05). Full CRUD for drivers
 * (DRV-01) and routes (RTE-*) extends these routers in later milestones.
 */
export function driversRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));
  router.get('/', async (_req, res) => {
    const rows: DriverOption[] = await db
      .select({ id: drivers.id, name: users.name, active: drivers.active })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .orderBy(asc(users.name));
    res.json(rows);
  });
  return router;
}

const routesQuery = z.object({ date: isoDateSchema });

export function routesRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));
  router.get('/', async (req, res) => {
    const { date } = routesQuery.parse(req.query);
    const rows: RouteOption[] = await db
      .select({ id: routes.id, name: routes.name, date: routes.date, status: routes.status, driverId: routes.driverId })
      .from(routes)
      .where(eq(routes.date, date))
      .orderBy(asc(routes.name));
    res.json(rows);
  });
  return router;
}
