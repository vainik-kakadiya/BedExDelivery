import {
  IMPORT_MAX_FILE_BYTES,
  type ImportParseResult,
  importCommitSchema,
  importPreviewSchema,
  orderCreateSchema,
  orderDeleteSchema,
  orderListQuerySchema,
  orderStatusChangeSchema,
  orderUpdateSchema,
  suggestImportMapping,
} from '@bedex/shared';
import express, { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { readSpreadsheet } from '../../lib/spreadsheet';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { commitImport, previewImport } from './import';
import { changeOrderStatus, createOrder, deleteOrders, getOrder, getOrderHistory, listOrders, updateOrder } from './service';

const uuid = z.string().uuid();
const parseId = (raw: string | undefined): string => {
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw notFound('Order not found');
  return parsed.data;
};

export function ordersRouter({ db, env, storage }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));

  router.get('/', async (req, res) => {
    res.json(await listOrders(db, orderListQuerySchema.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const order = await createOrder(db, orderCreateSchema.parse(req.body), currentUser(req));
    res.status(201).json(order);
  });

  // ---- ORD-05/06: import from CSV / Excel ----
  // 1. The raw file in, a plain table out (nothing is saved yet).
  router.post('/import/parse', express.raw({ type: () => true, limit: IMPORT_MAX_FILE_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest('Choose a CSV or Excel file to upload');
    const fileName = z.string().trim().min(1).max(255).catch('upload').parse(req.query.fileName);
    const table = await readSpreadsheet(req.body);
    res.json({ fileName, ...table, suggestedMapping: suggestImportMapping(table.headers) } satisfies ImportParseResult);
  });

  // 2. The table plus the column mapping: what would be imported, and why not.
  router.post('/import/preview', async (req, res) => {
    res.json(await previewImport(db, importPreviewSchema.parse(req.body)));
  });

  // 3. Create the orders.
  router.post('/import/commit', async (req, res) => {
    const input = importCommitSchema.parse(req.body);
    const result = await commitImport(db, input, currentUser(req));
    await audit(db, req, {
      action: 'orders_imported',
      entity: 'import_job',
      entityId: result.jobId,
      details: { fileName: input.fileName, imported: result.imported },
    });
    res.status(201).json(result);
  });

  // Delete orders created by mistake (one or many); the rest are reported back, not deleted.
  router.post('/delete', async (req, res) => {
    const { deletedOrders, ...result } = await deleteOrders(db, orderDeleteSchema.parse(req.body));
    if (deletedOrders.length) {
      await audit(db, req, {
        action: 'orders_deleted',
        entity: 'order',
        entityId: deletedOrders.length === 1 ? deletedOrders[0]!.id : undefined,
        details: { orders: deletedOrders },
      });
    }
    res.json(result);
  });

  router.get('/:id', async (req, res) => {
    res.json(await getOrder(db, parseId(req.params.id)));
  });

  router.patch('/:id', async (req, res) => {
    res.json(await updateOrder(db, parseId(req.params.id), orderUpdateSchema.parse(req.body), currentUser(req)));
  });

  router.post('/:id/status', async (req, res) => {
    res.json(await changeOrderStatus(db, parseId(req.params.id), orderStatusChangeSchema.parse(req.body), currentUser(req)));
  });

  router.get('/:id/history', async (req, res) => {
    res.json(await getOrderHistory(db, parseId(req.params.id), storage));
  });

  return router;
}
