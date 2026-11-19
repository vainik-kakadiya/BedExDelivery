import {
  driverCreateSchema,
  driverUpdateSchema,
  isoDateSchema,
  toLondonDate,
  vanDeactivateSchema,
  vanSchema,
  vanUpdateSchema,
} from '@bedex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { getVanImpact, takeVanOffRoad } from '../planning/service';
import { createDriver, createVan, getDriverProgress, listDrivers, listVans, updateDriver, updateVan } from './service';

const uuid = z.string().uuid();
const idParam = (raw: unknown, what: string) => {
  const parsed = uuid.safeParse(String(raw));
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
};

/**
 * DRV-01 / DRV-04. Office staff can see drivers and their progress; creating
 * drivers (which creates logins) is admin-only, per PRD §2.
 */
export function driversRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET));

  router.get('/', requireRole('admin', 'office'), async (_req, res) => {
    res.json(await listDrivers(db));
  });

  router.get('/progress', requireRole('admin', 'office'), async (req, res) => {
    const { date } = z.object({ date: isoDateSchema.optional() }).parse(req.query);
    res.json(await getDriverProgress(db, date ?? toLondonDate()));
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    res.status(201).json(await createDriver(db, driverCreateSchema.parse(req.body), currentUser(req)));
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const id = idParam(req.params.id, 'Driver');
    res.json(await updateDriver(db, id, driverUpdateSchema.parse(req.body), currentUser(req), toLondonDate()));
  });

  return router;
}

/** DRV-02. Admin manages vans; office staff can see them. */
export function vansRouter({ db, env, routing }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET));

  router.get('/', requireRole('admin', 'office'), async (_req, res) => {
    res.json(await listVans(db));
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    await createVan(db, vanSchema.parse(req.body), currentUser(req));
    res.status(201).json(await listVans(db));
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    await updateVan(db, idParam(req.params.id, 'Van'), vanUpdateSchema.parse(req.body), currentUser(req), toLondonDate());
    res.json(await listVans(db));
  });

  // Off the road (e.g. a breakdown): first see which routes it affects, then decide for each.
  router.get('/:id/impact', requireRole('admin'), async (req, res) => {
    res.json(await getVanImpact(db, idParam(req.params.id, 'Van'), toLondonDate()));
  });

  router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
    const id = idParam(req.params.id, 'Van');
    await takeVanOffRoad({ db, routing }, id, vanDeactivateSchema.parse(req.body), currentUser(req), toLondonDate());
    res.json(await listVans(db));
  });

  return router;
}
