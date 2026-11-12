import { dashboardQuerySchema, toLondonDate } from '@bedex/shared';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../lib/jwt';
import { requireAuth, requireRole } from '../../middleware/auth';
import { getDashboardLive, getDashboardSummary } from './service';

const KEEPALIVE_MS = 25_000;
/** The stream outlives no access token: the client reconnects with a fresh one. */
const MAX_STREAM_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

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

  // DSH-07: Server-Sent Events. The client refetches whatever the event names.
  router.get('/stream', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stop Nginx buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');

    const unsubscribe = changes.subscribe((tables) => {
      res.write(`event: change\ndata: ${JSON.stringify({ tables })}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    const expiry = setTimeout(() => res.end(), MAX_STREAM_MS);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
      clearTimeout(expiry);
    });
  });

  return router;
}
