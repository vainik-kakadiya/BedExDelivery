import { z } from 'zod';
import { ATTEMPT_OUTCOMES, ORDER_SOURCES } from './enums';
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

// ---------- public tracking ----------

export const trackQuerySchema = z.object({
  ref: z.string().trim().min(4).max(40),
  postcode: z.string().trim().min(5).max(10),
});
export type TrackQuery = z.infer<typeof trackQuerySchema>;
