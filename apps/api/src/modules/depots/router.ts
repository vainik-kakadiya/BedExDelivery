import { depots } from '@bedex/db';
import { type Depot, depotSchema, depotUpdateSchema } from '@bedex/shared';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { requireAuth, requireRole } from '../../middleware/auth';

const uuid = z.string().uuid();

const toDto = (d: typeof depots.$inferSelect): Depot => ({
  id: d.id,
  name: d.name,
  address: d.address,
  postcode: d.postcode,
  lat: d.lat,
  lng: d.lng,
  isDefault: d.isDefault,
  active: d.active,
});

/** RTE-02: depots. Reading is open to office staff; changes are admin-only. */
export function depotsRouter({ db, env }: AppContext) {
  const router = Router();
  router.use(requireAuth(env.JWT_ACCESS_SECRET));

  router.get('/', requireRole('admin', 'office'), async (_req, res) => {
    const rows = await db.select().from(depots).orderBy(desc(depots.active), desc(depots.isDefault), asc(depots.name));
    res.json(rows.map(toDto));
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const input = depotSchema.parse(req.body);
    const created = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: depots.id }).from(depots).limit(1);
      // The first depot becomes the default automatically.
      const isDefault = input.isDefault || existing.length === 0;
      if (isDefault) await tx.update(depots).set({ isDefault: false }).where(eq(depots.isDefault, true));
      const [row] = await tx.insert(depots).values({ ...input, isDefault, active: isDefault ? true : input.active }).returning();
      return row!;
    });
    await audit(db, req, { action: 'depot_created', entity: 'depot', entityId: created.id, details: { name: created.name } });
    res.status(201).json(toDto(created));
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw notFound('Depot not found');
    const input = depotUpdateSchema.parse(req.body);
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(depots).where(eq(depots.id, id.data)).for('update');
      if (!current) throw notFound('Depot not found');
      if (current.isDefault && (input.isDefault === false || input.active === false)) {
        throw conflict('DEFAULT_DEPOT', 'Make another depot the default first');
      }
      if (input.isDefault && input.active === false) throw conflict('DEFAULT_DEPOT', 'The default depot must be active');
      if (input.isDefault) {
        await tx.update(depots).set({ isDefault: false }).where(and(eq(depots.isDefault, true), ne(depots.id, id.data)));
      }
      const [row] = await tx
        .update(depots)
        .set({ ...input, ...(input.isDefault && { active: true }) })
        .where(eq(depots.id, id.data))
        .returning();
      return row!;
    });
    await audit(db, req, { action: 'depot_updated', entity: 'depot', entityId: updated.id, details: input });
    res.json(toDto(updated));
  });

  return router;
}
