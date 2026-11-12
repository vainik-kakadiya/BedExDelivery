import { sql } from 'drizzle-orm';
import { Router } from 'express';
import type { AppContext } from '../context';

/** For the uptime monitor (PRD §10). */
export function healthRouter({ db }: AppContext) {
  const router = Router();
  router.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });
  return router;
}
