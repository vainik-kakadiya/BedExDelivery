import { type Db, deliveryAttempts, depots, drivers, orders, routeStops, routes, users, vans } from '@bedex/db';
import {
  type DeliveryReportQuery,
  FAILURE_REASON_LABELS,
  ORDER_STATUS_META,
  formatTime,
  formatUkDate,
} from '@bedex/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { badRequest, notFound } from '../../lib/errors';
import type { TableExport } from '../../lib/tabular';
import { londonDateTime, londonTime, onLondonDates } from '../../lib/time';
import { type OrderFilters, orderFilterConditions } from '../orders/service';

const MAX_EXPORT_ROWS = 50_000;

/** "2× King bed frame; 1× Mattress" */
const itemsSummary = sql<string | null>`(
  select string_agg(oi.qty || '× ' || oi.name, '; ' order by oi.name)
  from order_items oi where oi.order_id = ${orders.id}
)`;

const window = (from: string | null, to: string | null) => (from && to ? `${formatTime(from)}–${formatTime(to)}` : '');
const ukDate = (d: string | null) => (d ? formatUkDate(d) : '');

function assertExportSize(n: number) {
  if (n > MAX_EXPORT_ROWS) {
    throw badRequest(`That export has more than ${MAX_EXPORT_ROWS.toLocaleString('en-GB')} rows. Narrow the filters and try again.`);
  }
}

// ---------- order list ----------

export async function buildOrdersExport(db: Db, filters: OrderFilters, today: string) {
  const conditions = orderFilterConditions(db, filters);
  const rows = await db
    .select({
      orderNumber: orders.orderNumber,
      trackingRef: orders.trackingRef,
      status: orders.status,
      scheduledDate: orders.scheduledDate,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      addressLine1: orders.addressLine1,
      addressLine2: orders.addressLine2,
      town: orders.town,
      postcode: orders.postcode,
      timeWindowStart: orders.timeWindowStart,
      timeWindowEnd: orders.timeWindowEnd,
      items: itemsSummary,
      deliveryNotes: orders.deliveryNotes,
      source: orders.source,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(MAX_EXPORT_ROWS + 1);
  assertExportSize(rows.length);

  const table: TableExport<(typeof rows)[number]> = {
    filename: `orders-${today}`,
    title: 'Orders',
    subtitle: `${rows.length} orders · exported ${formatUkDate(today)}`,
    landscape: true,
    columns: [
      { header: 'Order no.', value: (r) => r.orderNumber },
      { header: 'Tracking ref', value: (r) => r.trackingRef, width: 1.1 },
      { header: 'Status', value: (r) => ORDER_STATUS_META[r.status].label, width: 1.1 },
      { header: 'Date', value: (r) => ukDate(r.scheduledDate), width: 0.8 },
      { header: 'Customer', value: (r) => r.customerName, width: 1.2 },
      { header: 'Phone', value: (r) => r.customerPhone, width: 1.1 },
      { header: 'Email', value: (r) => r.customerEmail, width: 1.4 },
      { header: 'Address', value: (r) => [r.addressLine1, r.addressLine2].filter(Boolean).join(', '), width: 1.6 },
      { header: 'Town', value: (r) => r.town },
      { header: 'Postcode', value: (r) => r.postcode, width: 0.8 },
      { header: 'Window', value: (r) => window(r.timeWindowStart, r.timeWindowEnd), width: 0.8 },
      { header: 'Items', value: (r) => r.items, width: 1.8 },
      { header: 'Delivery notes', value: (r) => r.deliveryNotes, width: 1.5 },
      { header: 'Source', value: (r) => r.source, width: 0.7 },
      { header: 'Created', value: (r) => londonDateTime(r.createdAt), width: 1.1 },
    ],
    rows,
  };
  return table;
}

// ---------- delivery report ----------

export async function buildDeliveryReport(db: Db, q: DeliveryReportQuery) {
  const conditions = [onLondonDates(deliveryAttempts.occurredAt, q.from, q.to)];
  if (q.driverId) conditions.push(eq(deliveryAttempts.driverId, q.driverId));
  if (q.outcome) conditions.push(eq(deliveryAttempts.outcome, q.outcome));

  const rows = await db
    .select({
      occurredAt: deliveryAttempts.occurredAt,
      orderNumber: orders.orderNumber,
      trackingRef: orders.trackingRef,
      customerName: orders.customerName,
      postcode: orders.postcode,
      routeName: routes.name,
      driverName: users.name,
      attemptNo: deliveryAttempts.attemptNo,
      outcome: deliveryAttempts.outcome,
      failureReason: deliveryAttempts.failureReason,
      recipientName: deliveryAttempts.recipientName,
      leftAtType: deliveryAttempts.leftAtType,
      leftAtNote: deliveryAttempts.leftAtNote,
      notes: deliveryAttempts.notes,
    })
    .from(deliveryAttempts)
    .innerJoin(orders, eq(orders.id, deliveryAttempts.orderId))
    .leftJoin(routes, eq(routes.id, deliveryAttempts.routeId))
    .leftJoin(drivers, eq(drivers.id, deliveryAttempts.driverId))
    .leftJoin(users, eq(users.id, drivers.userId))
    .where(and(...conditions))
    .orderBy(asc(deliveryAttempts.occurredAt))
    .limit(MAX_EXPORT_ROWS + 1);
  assertExportSize(rows.length);

  const outcomeLabel = { delivered: 'Delivered', partial: 'Partially delivered', failed: 'Failed' } as const;
  const leftAtLabel = { customer: 'Handed to customer', neighbour: 'Neighbour', safe_place: 'Safe place' } as const;
  const range = q.from === q.to ? formatUkDate(q.from) : `${formatUkDate(q.from)} – ${formatUkDate(q.to)}`;

  const table: TableExport<(typeof rows)[number]> = {
    filename: q.from === q.to ? `delivery-report-${q.from}` : `delivery-report-${q.from}-to-${q.to}`,
    title: 'Delivery report',
    subtitle: `${range} · ${rows.length} attempts`,
    landscape: true,
    columns: [
      { header: 'Date & time', value: (r) => londonDateTime(r.occurredAt), width: 1.1 },
      { header: 'Order no.', value: (r) => r.orderNumber },
      { header: 'Tracking ref', value: (r) => r.trackingRef, width: 1.1 },
      { header: 'Customer', value: (r) => r.customerName, width: 1.2 },
      { header: 'Postcode', value: (r) => r.postcode, width: 0.8 },
      { header: 'Route', value: (r) => r.routeName },
      { header: 'Driver', value: (r) => r.driverName },
      { header: 'Attempt', value: (r) => r.attemptNo, width: 0.6 },
      { header: 'Outcome', value: (r) => outcomeLabel[r.outcome], width: 0.9 },
      { header: 'Failure reason', value: (r) => (r.failureReason ? FAILURE_REASON_LABELS[r.failureReason] : ''), width: 1.1 },
      { header: 'Recipient', value: (r) => r.recipientName },
      {
        header: 'Left at',
        value: (r) => [r.leftAtType ? leftAtLabel[r.leftAtType] : '', r.leftAtNote].filter(Boolean).join(' – '),
        width: 1.3,
      },
      { header: 'Notes', value: (r) => r.notes, width: 1.6 },
    ],
    rows,
  };
  return table;
}

// ---------- route manifest (RTE-10) ----------

export async function buildManifest(db: Db, routeId: string) {
  const [route] = await db
    .select({
      name: routes.name,
      date: routes.date,
      totalMiles: routes.totalMiles,
      depotName: depots.name,
      driverName: users.name,
      vanName: vans.name,
      vanRegistration: vans.registration,
    })
    .from(routes)
    .innerJoin(depots, eq(depots.id, routes.depotId))
    .leftJoin(drivers, eq(drivers.id, routes.driverId))
    .leftJoin(users, eq(users.id, drivers.userId))
    .leftJoin(vans, eq(vans.id, routes.vanId))
    .where(eq(routes.id, routeId));
  if (!route) throw notFound('Route not found');

  const stops = await db
    .select({
      sequence: routeStops.sequence,
      eta: routeStops.eta,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      addressLine1: orders.addressLine1,
      addressLine2: orders.addressLine2,
      town: orders.town,
      postcode: orders.postcode,
      timeWindowStart: orders.timeWindowStart,
      timeWindowEnd: orders.timeWindowEnd,
      items: itemsSummary,
      accessInstructions: orders.accessInstructions,
      deliveryNotes: orders.deliveryNotes,
      requiresSignature: orders.requiresSignature,
    })
    .from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(eq(routeStops.routeId, routeId))
    .orderBy(asc(routeStops.sequence));

  const parts = [
    `Driver: ${route.driverName ?? 'unassigned'}`,
    `Van: ${route.vanName ? `${route.vanName}${route.vanRegistration ? ` (${route.vanRegistration})` : ''}` : 'unassigned'}`,
    `Depot: ${route.depotName}`,
    `${stops.length} stops`,
    ...(route.totalMiles ? [`${route.totalMiles.toFixed(1)} miles`] : []),
  ];

  const table: TableExport<(typeof stops)[number]> = {
    filename: `manifest-${route.date}-${route.name}`,
    title: `Route manifest – ${route.name} – ${formatUkDate(route.date)}`,
    subtitle: parts.join(' · '),
    landscape: true,
    columns: [
      { header: '#', value: (s) => s.sequence, width: 0.35 },
      { header: 'ETA', value: (s) => londonTime(s.eta), width: 0.5 },
      { header: 'Window', value: (s) => window(s.timeWindowStart, s.timeWindowEnd), width: 0.75 },
      { header: 'Order no.', value: (s) => s.orderNumber, width: 0.8 },
      { header: 'Customer', value: (s) => s.customerName, width: 1.1 },
      { header: 'Phone', value: (s) => s.customerPhone, width: 1 },
      {
        header: 'Address',
        value: (s) => [s.addressLine1, s.addressLine2, s.town].filter(Boolean).join(', '),
        width: 1.8,
      },
      { header: 'Postcode', value: (s) => s.postcode, width: 0.7 },
      { header: 'Items', value: (s) => s.items, width: 1.6 },
      {
        header: 'Notes',
        value: (s) =>
          [s.requiresSignature ? 'SIGNATURE REQUIRED' : '', s.accessInstructions, s.deliveryNotes].filter(Boolean).join(' · '),
        width: 2,
      },
    ],
    rows: stops,
  };
  return table;
}
