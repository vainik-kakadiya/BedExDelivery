import { z } from 'zod';
import { ATTEMPT_OUTCOMES, LEFT_AT_TYPES, ORDER_SOURCES, ROUTE_END_TYPES } from './enums';
import { normalisePhone, normalisePostcode } from './format';
import { ORDER_STATUSES } from './status';

// ---------- building blocks ----------

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** Optional free text: "" → null so PATCH can clear a field; undefined = unchanged. */
const optText = (max = 2000) => z.preprocess(emptyToNull, z.string().trim().max(max).nullish());

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const postcodeSchema = z.string().transform((v, ctx) => {
  const normalised = normalisePostcode(v);
  if (!normalised) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid UK postcode' });
    return z.NEVER;
  }
  return normalised;
});

const phoneSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .min(6)
    .max(25)
    .transform(normalisePhone)
    .nullish(),
);

const emailSchema = z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(254).nullish());

// ---------- auth ----------

export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or phone').max(254),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------- orders ----------

export const orderItemSchema = z.object({
  sku: optText(64),
  name: z.string().trim().min(1).max(200),
  qty: z.coerce.number().int().min(1).max(999),
  /** Load units per item, used as the optimiser's capacity demand. */
  units: z.coerce.number().min(0).max(1000).default(1),
  weightKg: z.coerce.number().min(0).max(5000).nullish(),
  volumeM3: z.coerce.number().min(0).max(100).nullish(),
});
export type OrderItemInput = z.infer<typeof orderItemSchema>;

const orderFields = z.object({
  orderNumber: z.string().trim().min(1).max(64),
  customerName: z.string().trim().min(1).max(200),
  customerPhone: phoneSchema,
  customerEmail: emailSchema,
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: optText(200),
  town: z.string().trim().min(1).max(100),
  postcode: postcodeSchema,
  accessInstructions: optText(),
  deliveryNotes: optText(),
  internalNotes: optText(),
  timeWindowStart: timeOfDaySchema.nullish(),
  timeWindowEnd: timeOfDaySchema.nullish(),
  serviceMinutes: z.coerce.number().int().min(0).max(480).default(10),
  extraMinutes: z.coerce.number().int().min(0).max(480).default(0),
  extraReason: optText(200),
  requiresSignature: z.boolean().default(false),
  scheduledDate: isoDateSchema.nullish(),
  items: z.array(orderItemSchema).min(1, 'Add at least one item').max(200),
});

interface OrderRuleFields {
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  extraMinutes?: number;
  extraReason?: string | null;
}

/** Cross-field rules; the API re-runs these on the merged record for PATCH. */
export function orderRuleIssues(v: OrderRuleFields): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (Boolean(v.timeWindowStart) !== Boolean(v.timeWindowEnd)) {
    issues.push({ path: 'timeWindowEnd', message: 'Give both a start and an end time, or neither' });
  } else if (v.timeWindowStart && v.timeWindowEnd && v.timeWindowStart.slice(0, 5) >= v.timeWindowEnd.slice(0, 5)) {
    issues.push({ path: 'timeWindowEnd', message: 'End time must be after start time' });
  }
  if ((v.extraMinutes ?? 0) > 0 && !v.extraReason) {
    issues.push({ path: 'extraReason', message: 'Give a reason for the extra time' });
  }
  return issues;
}

const applyOrderRules = (v: OrderRuleFields, ctx: z.RefinementCtx) => {
  for (const issue of orderRuleIssues(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  }
};

export const orderCreateSchema = orderFields.superRefine(applyOrderRules);
export type OrderCreateInput = z.infer<typeof orderCreateSchema>;

/** Status is never set here – use the status endpoint so the machine is enforced. */
export const orderUpdateSchema = orderFields.partial();
export type OrderUpdateInput = z.infer<typeof orderUpdateSchema>;

export const orderStatusChangeSchema = z
  .object({
    to: z.enum(ORDER_STATUSES),
    reason: optText(500),
    note: optText(1000),
    /** The newly agreed date – required when moving to "rescheduled". */
    scheduledDate: isoDateSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.to === 'cancelled' && !v.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required to cancel an order' });
    }
    if (v.to === 'rescheduled' && !v.scheduledDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledDate'], message: 'Choose the new delivery date' });
    }
  });
export type OrderStatusChangeInput = z.infer<typeof orderStatusChangeSchema>;

export const orderDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Choose at least one order').max(500, 'Delete at most 500 orders at a time'),
});
export type OrderDeleteInput = z.infer<typeof orderDeleteSchema>;

const csvList = (v: unknown) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v);

export const orderListQuerySchema = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(100).optional()),
  status: z.preprocess(csvList, z.array(z.enum(ORDER_STATUSES)).optional()),
  date: z.preprocess(emptyToUndefined, isoDateSchema.optional()),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  routeId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  postcodePrefix: z.preprocess(emptyToUndefined, z.string().trim().max(8).optional()),
  source: z.preprocess(emptyToUndefined, z.enum(ORDER_SOURCES).optional()),
  cursor: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

// ---------- dashboard & exports ----------

export const dashboardQuerySchema = z.object({
  date: z.preprocess(emptyToUndefined, isoDateSchema.optional()),
});

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
const exportFormat = (fallback: ExportFormat) => z.preprocess(emptyToUndefined, z.enum(EXPORT_FORMATS).default(fallback));

/** DSH-06: same filters as the order list, without pagination. */
export const orderExportQuerySchema = orderListQuerySchema.omit({ cursor: true, limit: true }).extend({ format: exportFormat('csv') });
export type OrderExportQuery = z.infer<typeof orderExportQuerySchema>;

export const deliveryReportQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
    outcome: z.preprocess(emptyToUndefined, z.enum(ATTEMPT_OUTCOMES).optional()),
    format: exportFormat('csv'),
  })
  .superRefine((v, ctx) => {
    if (v.from > v.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '"To" must be on or after "From"' });
    const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
    if (days > 366) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Choose a range of a year or less' });
  });
export type DeliveryReportQuery = z.infer<typeof deliveryReportQuerySchema>;

export const manifestQuerySchema = z.object({ format: exportFormat('pdf') });

// ---------- depots, settings, route planning (RTE-*) ----------

export const depotSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(300),
  postcode: postcodeSchema,
  // Roughly the UK, to catch swapped or mistyped coordinates.
  lat: z.coerce.number().min(49).max(61),
  lng: z.coerce.number().min(-9).max(2.5),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type DepotInput = z.infer<typeof depotSchema>;
export const depotUpdateSchema = depotSchema.partial();

/** ORD-07: a pin dropped by the office when the address lookup failed or was only approximate. */
export const orderLocationSchema = z.object({
  lat: z.coerce.number().min(49, 'That point is outside the UK').max(61, 'That point is outside the UK'),
  lng: z.coerce.number().min(-9, 'That point is outside the UK').max(2.5, 'That point is outside the UK'),
});
export type OrderLocationInput = z.infer<typeof orderLocationSchema>;

/** DSH-03: a GPS fix from the driver app while a route is out. Not limited to the UK: a bad fix is still worth seeing. */
export const driverLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Metres, as the browser reports it. */
  accuracy: z.number().min(0).max(100_000).optional(),
  /** When the phone took the fix (it may have been sent late). */
  recordedAt: z.string().datetime({ offset: true }).optional(),
});
export type DriverLocationInput = z.infer<typeof driverLocationSchema>;

export const settingsPatchSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

const uuid = z.string().uuid();
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;

export const optimiseRequestSchema = z.object({
  date: isoDateSchema,
  depotId: uuid,
  endType: z.enum(ROUTE_END_TYPES),
  vehicles: z
    .array(z.object({ driverId: uuid, vanId: uuid }))
    .min(1, 'Choose at least one driver')
    .max(30)
    .refine((v) => uniqueIds(v.map((x) => x.driverId)), 'Each driver can only be used once')
    .refine((v) => uniqueIds(v.map((x) => x.vanId)), 'Each van can only be used once'),
  /** Orders to plan; omitted = every eligible order for the date. */
  orderIds: z.array(uuid).max(2000).refine(uniqueIds, 'Duplicate orders').optional(),
});
export type OptimiseRequest = z.infer<typeof optimiseRequestSchema>;

export const routeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  driverId: uuid.nullable().optional(),
  vanId: uuid.nullable().optional(),
  endType: z.enum(ROUTE_END_TYPES).optional(),
});
export type RouteUpdateInput = z.infer<typeof routeUpdateSchema>;

/** RTE-07: the complete new stop order for a route (adds, removes, moves, reorders). */
export const routeStopsSchema = z.object({
  orderIds: z.array(uuid).max(300).refine(uniqueIds, 'An order can only appear once'),
});

/** DRV-05: move outstanding stops to another route (works on routes already on the road). */
export const stopTransferSchema = z.object({
  orderIds: z.array(uuid).min(1, 'Choose at least one stop').max(300).refine(uniqueIds, 'Duplicate orders'),
  toRouteId: uuid,
});

// ---------- drivers & vans (DRV-01, DRV-02) ----------

const nullableNumber = (min: number, max: number) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().min(min).max(max).nullable());

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(200);

const driverFields = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  email: emailSchema,
  phone: phoneSchema,
  workStart: timeOfDaySchema,
  workEnd: timeOfDaySchema,
  maxHours: z.coerce.number().min(1).max(16),
  defaultVanId: z.preprocess(emptyToNull, z.string().uuid().nullish()),
  homeAddress: optText(300),
  homePostcode: z.preprocess(emptyToNull, postcodeSchema.nullish()),
  homeLat: nullableNumber(49, 61),
  homeLng: nullableNumber(-9, 2.5),
});

interface DriverRuleFields {
  email?: string | null;
  phone?: string | null;
  workStart?: string;
  workEnd?: string;
  homeLat?: number | null;
  homeLng?: number | null;
}

function driverRules(v: DriverRuleFields, ctx: z.RefinementCtx, requireLogin: boolean) {
  if (requireLogin && !v.email && !v.phone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Give an email or a phone number to log in with' });
  }
  if (v.workStart && v.workEnd && v.workStart >= v.workEnd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workEnd'], message: 'Finish must be after start' });
  }
  if ((v.homeLat === null || v.homeLat === undefined) !== (v.homeLng === null || v.homeLng === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['homeLng'], message: 'Give both latitude and longitude, or neither' });
  }
}

export const driverCreateSchema = driverFields.extend({ password: passwordSchema }).superRefine((v, ctx) => driverRules(v, ctx, true));
export type DriverCreateInput = z.infer<typeof driverCreateSchema>;

export const driverUpdateSchema = driverFields
  .partial()
  .extend({
    /** Set to reset the driver's password; omit to keep it. */
    password: z.preprocess(emptyToUndefined, passwordSchema.optional()),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => driverRules(v, ctx, false));
export type DriverUpdateInput = z.infer<typeof driverUpdateSchema>;

export const vanSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .transform((v) => v.toUpperCase().replace(/\s+/g, ' ')),
  name: z.string().trim().min(1, 'Enter a name').max(60),
  capacityUnits: z.coerce.number().positive('Must be more than 0').max(10_000),
  capacityKg: nullableNumber(0, 50_000),
  capacityM3: nullableNumber(0, 200),
  active: z.boolean().default(true),
});
export type VanInput = z.infer<typeof vanSchema>;
export const vanUpdateSchema = vanSchema.partial();

/**
 * DRV-02: take a van off the road (e.g. it has broken down). Every route still
 * using it, today or later, says what happens to it:
 * - swap: keep the route, use another van
 * - unassign: keep the stops and driver with no van (a released route goes back to draft)
 * - unplan: remove the route; its orders go back to be planned again
 * - transfer: move the outstanding stops to another route on the same day
 */
export const VAN_ROUTE_ACTIONS = ['swap', 'unassign', 'unplan', 'transfer'] as const;
export type VanRouteAction = (typeof VAN_ROUTE_ACTIONS)[number];

export const vanDeactivateSchema = z.object({
  reason: optText(200),
  routes: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ routeId: uuid, action: z.literal('swap'), vanId: uuid }),
        z.object({ routeId: uuid, action: z.literal('unassign') }),
        z.object({ routeId: uuid, action: z.literal('unplan') }),
        z.object({ routeId: uuid, action: z.literal('transfer'), toRouteId: uuid }),
      ]),
    )
    .max(200)
    .refine((v) => uniqueIds(v.map((r) => r.routeId)), 'Each route can only have one decision')
    .default([]),
});
export type VanDeactivateInput = z.infer<typeof vanDeactivateSchema>;

// ---------- public tracking ----------

export const trackQuerySchema = z.object({
  ref: z.string().trim().min(4).max(40),
  postcode: z.string().trim().min(5).max(10),
});
export type TrackQuery = z.infer<typeof trackQuerySchema>;

// ---------- driver: proof of delivery (DRP-05) ----------

/** Photos live under orders/<orderId>/<stopId>/; the API rejects paths outside the stop being completed. */
export const MAX_PROOF_PHOTOS = 6;

export const stopDeliveredSchema = z
  .object({
    outcome: z.literal('delivered'),
    recipientName: z.string().trim().min(1, 'Enter who took the delivery').max(120),
    leftAtType: z.enum(LEFT_AT_TYPES),
    leftAtNote: z.preprocess(emptyToNull, z.string().trim().max(300).nullish()),
    notes: z.preprocess(emptyToNull, z.string().trim().max(1000).nullish()),
    photos: z
      .array(z.object({ path: z.string().min(1).max(300), takenAt: z.string().datetime().nullish() }))
      .min(1, 'Take at least one photo')
      .max(MAX_PROOF_PHOTOS, `At most ${MAX_PROOF_PHOTOS} photos`),
    /** Generated on the device so a retried request never records the delivery twice (DRP-06). */
    clientActionId: uuid,
    occurredAt: z.string().datetime().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.leftAtType === 'neighbour' && !v.leftAtNote) {
      ctx.addIssue({ code: 'custom', path: ['leftAtNote'], message: "Enter the neighbour's door number" });
    }
    if (v.leftAtType === 'safe_place' && !v.leftAtNote) {
      ctx.addIssue({ code: 'custom', path: ['leftAtNote'], message: 'Describe the safe place' });
    }
  });
export type StopDeliveredInput = z.infer<typeof stopDeliveredSchema>;

export const LEFT_AT_LABELS = {
  customer: 'Handed to customer',
  neighbour: 'Left with neighbour',
  safe_place: 'Safe place',
} as const;
