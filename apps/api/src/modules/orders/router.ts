import { orderCreateSchema, orderListQuerySchema, orderStatusChangeSchema, orderUpdateSchema } from '@bedex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { changeOrderStatus, createOrder, getOrder, getOrderHistory, listOrders, updateOrder } from './service';

const uuid = z.string().uuid();
const parseId = (raw: string | undefined): string => {
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw notFound('Order not found');
  return parsed.data;
};

export function ordersRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET), requireRole('admin', 'office'));

  router.get('/', async (req, res) => {
    res.json(await listOrders(db, orderListQuerySchema.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const order = await createOrder(db, orderCreateSchema.parse(req.body), currentUser(req));
    res.status(201).json(order);
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
    res.json(await getOrderHistory(db, parseId(req.params.id)));
  });

  return router;
}
