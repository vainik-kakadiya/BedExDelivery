import { dashboardQuerySchema, toLondonDate } from '@bedex/shared';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { changeStream } from '../../lib/sse';
import { requireAuth, requireRole } from '../../middleware/auth';
import { getDashboardLive, getDashboardSummary } from './service';

export function dashboardRouter({ db, env, changes }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));

  // DSH-01, DSH-02, DSH-04
  router.get('/summary', async (req, res) => {
    const { date } = dashboardQuerySchema.parse(req.query);
    res.json(await getDashboardSummary(db, date ?? toLondonDate()));
  });

  // DSH-03
  router.get('/live', async (req, res) => {
    const { date } = dashboardQuerySchema.parse(req.query);
    res.json(await getDashboardLive(db, date ?? toLondonDate()));
  });

  // DSH-07: the client refetches whatever the event names.
  router.get('/stream', changeStream(changes));

  return router;
}
