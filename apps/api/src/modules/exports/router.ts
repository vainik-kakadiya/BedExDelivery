import { deliveryReportQuerySchema, manifestQuerySchema, orderExportQuerySchema, toLondonDate } from '@bedex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { sendTable } from '../../lib/tabular';
import { requireAuth, requireRole } from '../../middleware/auth';
import { buildDeliveryReport, buildManifest, buildOrdersExport } from './service';

const uuid = z.string().uuid();

/** DSH-06 / RTE-10 / ACC-04. Every export is written to the audit log (ACC-03). */
export function exportsRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));

  router.get('/orders', async (req, res) => {
    const { format, ...filters } = orderExportQuerySchema.parse(req.query);
    const table = await buildOrdersExport(db, filters, toLondonDate());
    await audit(db, req, { action: 'export', entity: 'orders', details: { format, rows: table.rows.length, filters } });
    await sendTable(res, format, table);
  });

  router.get('/deliveries', async (req, res) => {
    const query = deliveryReportQuerySchema.parse(req.query);
    const table = await buildDeliveryReport(db, query);
    await audit(db, req, { action: 'export', entity: 'deliveries', details: { ...query, rows: table.rows.length } });
    await sendTable(res, query.format, table);
  });

  router.get('/manifest/:routeId', async (req, res) => {
    const routeId = uuid.safeParse(req.params.routeId);
    if (!routeId.success) throw notFound('Route not found');
    const { format } = manifestQuerySchema.parse(req.query);
    const table = await buildManifest(db, routeId.data);
    await audit(db, req, { action: 'export', entity: 'manifest', entityId: routeId.data, details: { format } });
    await sendTable(res, format, table);
  });

  return router;
}
