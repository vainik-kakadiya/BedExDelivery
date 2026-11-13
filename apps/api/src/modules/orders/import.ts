import { type Db, type DbOrTx, importJobs, orderEvents, orderItems, orders } from '@bedex/db';
import {
  type DuplicateProbe,
  type ImportCandidate,
  type ImportCommitInput,
  type ImportCommitResult,
  type ImportOrderStatus,
  type ImportPreview,
  type ImportPreviewInput,
  type ImportPreviewOrder,
  type OrderCreateInput,
  buildImportCandidates,
  formatUkDate,
  generateTrackingRef,
  looksLikeDuplicate,
  postcodeKey,
  toLondonDate,
} from '@bedex/shared';
import { and, gte, inArray, ne } from 'drizzle-orm';
import { badRequest } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import { getSettings } from '../settings/service';

/** Postgres caps a statement at 65,535 parameters; orders have ~25 columns. */
const INSERT_CHUNK = 500;
const QUERY_CHUNK = 1000;

const chunk = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

interface PlannedOrder extends ImportPreviewOrder {
  input: OrderCreateInput | null;
}

const probeFor = (input: OrderCreateInput): DuplicateProbe => ({
  postcode: input.postcode,
  phone: input.customerPhone ?? null,
  customerName: input.customerName,
  itemNames: input.items.map((i) => i.name),
});

/** ORD-05/06: validate every order in the file and check it against existing orders. */
async function planImport(db: DbOrTx, input: ImportPreviewInput): Promise<{ orders: PlannedOrder[]; windowDays: number }> {
  const settings = await getSettings(db);
  const windowDays = settings['import.duplicateWindowDays'];
  const candidates = buildImportCandidates(input.rows, input.mapping, { serviceMinutes: settings['orders.defaultServiceMinutes'] });
  const valid = candidates.filter((c): c is ImportCandidate & { input: OrderCreateInput } => c.input !== null);

  // Order numbers already in the system.
  const existing = new Set<string>();
  for (const part of chunk(valid.map((c) => c.orderNumber), QUERY_CHUNK)) {
    const rows = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.orderNumber, part));
    for (const r of rows) existing.add(r.orderNumber);
  }

  // Recent orders at the same postcodes, for the duplicate check.
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const recentByPostcode = new Map<string, (DuplicateProbe & { orderNumber: string; createdAt: Date })[]>();
  const postcodes = [...new Set(valid.map((c) => c.input.postcode))];
  for (const part of chunk(postcodes, QUERY_CHUNK)) {
    const recent = await db.query.orders.findMany({
      where: and(inArray(orders.postcode, part), gte(orders.createdAt, since), ne(orders.status, 'cancelled')),
      columns: { orderNumber: true, postcode: true, customerPhone: true, customerName: true, createdAt: true },
      with: { items: { columns: { name: true } } },
    });
    for (const o of recent) {
      const key = postcodeKey(o.postcode);
      const list = recentByPostcode.get(key) ?? [];
      list.push({
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        postcode: o.postcode,
        phone: o.customerPhone,
        customerName: o.customerName,
        itemNames: o.items.map((i) => i.name),
      });
      recentByPostcode.set(key, list);
    }
  }

  // Earlier orders in this same file count too (e.g. one order entered twice under two numbers).
  const seenInFile = new Map<string, (DuplicateProbe & { orderNumber: string })[]>();

  const planned = candidates.map((c): PlannedOrder => {
    const base = {
      rows: c.rows,
      orderNumber: c.orderNumber,
      customerName: c.input?.customerName ?? c.customerName,
      postcode: c.input?.postcode ?? c.postcode,
      town: c.input?.town ?? c.town,
      scheduledDate: c.input?.scheduledDate ?? null,
      itemCount: c.input?.items.length ?? 0,
      input: c.input,
    };
    if (!c.input) return { ...base, status: 'error', messages: c.errors };
    if (existing.has(c.orderNumber)) {
      return { ...base, status: 'exists', messages: [`Order ${c.orderNumber} is already in the system`] };
    }

    const probe = probeFor(c.input);
    const key = postcodeKey(probe.postcode);
    const fileList = seenInFile.get(key) ?? [];
    seenInFile.set(key, [...fileList, { ...probe, orderNumber: c.orderNumber }]);

    const recent = recentByPostcode.get(key)?.find((o) => looksLikeDuplicate(probe, o));
    if (recent) {
      const when = formatUkDate(toLondonDate(recent.createdAt));
      return { ...base, status: 'duplicate', messages: [`Looks like order ${recent.orderNumber} (added ${when}): same customer, postcode and product`] };
    }
    const twin = fileList.find((o) => looksLikeDuplicate(probe, o));
    if (twin) {
      return { ...base, status: 'duplicate', messages: [`Looks like order ${twin.orderNumber} earlier in this file: same customer, postcode and product`] };
    }
    return { ...base, status: 'ready', messages: [] };
  });

  return { orders: planned, windowDays };
}

const countByStatus = (list: { status: ImportOrderStatus }[]) => {
  const counts: Record<ImportOrderStatus, number> = { ready: 0, duplicate: 0, exists: 0, error: 0 };
  for (const o of list) counts[o.status]++;
  return counts;
};

export async function previewImport(db: Db, input: ImportPreviewInput): Promise<ImportPreview> {
  const plan = await planImport(db, input);
  return {
    orders: plan.orders.map(({ input: _input, ...o }) => o),
    counts: countByStatus(plan.orders),
    duplicateWindowDays: plan.windowDays,
  };
}

export async function commitImport(db: Db, input: ImportCommitInput, actor: AuthUser): Promise<ImportCommitResult> {
  return db.transaction(async (tx) => {
    // Re-check inside the transaction: orders may have been added since the preview.
    const plan = await planImport(tx, input);
    const counts = countByStatus(plan.orders);
    const toImport = plan.orders.filter(
      (o): o is PlannedOrder & { input: OrderCreateInput } =>
        o.input !== null && (o.status === 'ready' || (input.includePossibleDuplicates && o.status === 'duplicate')),
    );
    if (toImport.length === 0) throw badRequest('There are no orders to import from this file');

    const mapping = Object.fromEntries(Object.entries(input.mapping).map(([field, col]) => [input.headers[col] ?? `Column ${col + 1}`, field]));
    const problems = plan.orders
      .filter((o) => o.status === 'error' || o.status === 'exists')
      .flatMap((o) => o.messages.map((message) => ({ row: o.rows[0] ?? 0, message: `${o.orderNumber || 'No order number'}: ${message}` })));

    const [job] = await tx
      .insert(importJobs)
      .values({
        fileName: input.fileName,
        status: 'committed',
        mapping,
        rowsTotal: input.rows.length,
        rowsImported: toImport.length,
        duplicates: counts.duplicate,
        errors: problems.slice(0, 1000),
        createdBy: actor.id,
        committedAt: new Date(),
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error('Import job insert returned no row');

    const refs = await uniqueTrackingRefs(tx, toImport.length);
    const ids = new Map<string, string>();
    for (const part of chunk(toImport.map((o, i) => ({ o, ref: refs[i]! })), INSERT_CHUNK)) {
      const inserted = await tx
        .insert(orders)
        .values(
          part.map(({ o, ref }) => {
            const { items: _items, ...fields } = o.input;
            return { ...fields, trackingRef: ref, source: 'import' as const, createdBy: actor.id };
          }),
        )
        .returning({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status });
      for (const row of inserted) ids.set(row.orderNumber, row.id);
    }

    const itemRows = toImport.flatMap((o) =>
      o.input.items.map((i) => ({
        orderId: ids.get(o.orderNumber)!,
        sku: i.sku ?? null,
        name: i.name,
        qty: i.qty,
        units: i.units,
        weightKg: i.weightKg ?? null,
        volumeM3: i.volumeM3 ?? null,
      })),
    );
    for (const part of chunk(itemRows, INSERT_CHUNK)) await tx.insert(orderItems).values(part);

    const events = toImport.map((o) => ({
      orderId: ids.get(o.orderNumber)!,
      actorId: actor.id,
      actorRole: actor.role,
      type: 'created',
      toStatus: 'awaiting_scheduling' as const,
      payload: { source: 'import', importJobId: job.id, fileName: input.fileName, rows: o.rows },
    }));
    for (const part of chunk(events, INSERT_CHUNK)) await tx.insert(orderEvents).values(part);
    // TODO(ORD-07): enqueue geocoding for the imported orders.

    const importedDuplicates = input.includePossibleDuplicates ? counts.duplicate : 0;
    return {
      jobId: job.id,
      imported: toImport.length,
      skippedExisting: counts.exists,
      skippedDuplicates: counts.duplicate - importedDuplicates,
      failed: counts.error,
    };
  });
}

async function uniqueTrackingRefs(tx: DbOrTx, count: number): Promise<string[]> {
  const refs = new Set<string>();
  for (let attempt = 0; attempt < 5 && refs.size < count; attempt++) {
    const fresh: string[] = [];
    while (refs.size + fresh.length < count) {
      const ref = generateTrackingRef();
      if (!refs.has(ref) && !fresh.includes(ref)) fresh.push(ref);
    }
    const taken = new Set<string>();
    for (const part of chunk(fresh, QUERY_CHUNK)) {
      const hits = await tx.select({ ref: orders.trackingRef }).from(orders).where(inArray(orders.trackingRef, part));
      for (const h of hits) taken.add(h.ref);
    }
    for (const ref of fresh) if (!taken.has(ref)) refs.add(ref);
  }
  if (refs.size < count) throw new Error('Could not generate unique tracking references');
  return [...refs];
}
