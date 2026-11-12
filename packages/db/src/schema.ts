/**
 * PRD §7 data model. Generate migrations with `pnpm db:generate` after edits.
 * The pg_trgm extension is created by the first (hand-written) migration.
 *
 * SECURITY: every table MUST end in `.enableRLS()`. Supabase serves the public
 * schema over its REST API to the public anon key; RLS with no policies denies
 * that path entirely. Our API connects as the table owner and is unaffected.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ATTEMPT_OUTCOMES,
  FAILURE_REASONS,
  GEOCODE_STATUSES,
  IMPORT_STATUSES,
  ISSUE_TYPES,
  LEFT_AT_TYPES,
  ORDER_SOURCES,
  ORDER_STATUSES,
  PHOTO_TYPES,
  ROLES,
  ROUTE_END_TYPES,
  ROUTE_STATUSES,
} from '@bedex/shared';

// ---------- enums ----------

export const roleEnum = pgEnum('user_role', ROLES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const routeStatusEnum = pgEnum('route_status', ROUTE_STATUSES);
export const orderSourceEnum = pgEnum('order_source', ORDER_SOURCES);
export const geocodeStatusEnum = pgEnum('geocode_status', GEOCODE_STATUSES);
export const routeEndTypeEnum = pgEnum('route_end_type', ROUTE_END_TYPES);
export const attemptOutcomeEnum = pgEnum('attempt_outcome', ATTEMPT_OUTCOMES);
export const failureReasonEnum = pgEnum('failure_reason', FAILURE_REASONS);
export const leftAtTypeEnum = pgEnum('left_at_type', LEFT_AT_TYPES);
export const issueTypeEnum = pgEnum('issue_type', ISSUE_TYPES);
export const photoTypeEnum = pgEnum('photo_type', PHOTO_TYPES);
export const importStatusEnum = pgEnum('import_status', IMPORT_STATUSES);

// ---------- helpers ----------

/** Millisecond precision so JS Dates round-trip exactly (keyset pagination). */
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () =>
  ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- users & auth ----------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email'),
    /** E.164, see normalisePhone(). */
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull(),
    active: boolean('active').notNull().default(true),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`), uniqueIndex('users_phone_unique').on(t.phone)],
).enableRLS();

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** All tokens descended from one login share a family; reuse revokes the family. */
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedById: uuid('replaced_by_id'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_family_idx').on(t.familyId),
  ],
).enableRLS();

// ---------- depots, vans, drivers ----------

export const depots = pgTable(
  'depots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    address: text('address').notNull(),
    postcode: text('postcode').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('depots_single_default').on(t.isDefault).where(sql`${t.isDefault} = true`)],
).enableRLS();

export const vans = pgTable(
  'vans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registration: text('registration').notNull(),
    name: text('name').notNull(),
    capacityUnits: doublePrecision('capacity_units').notNull(),
    capacityKg: doublePrecision('capacity_kg'),
    capacityM3: doublePrecision('capacity_m3'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('vans_registration_unique').on(t.registration)],
).enableRLS();

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    defaultVanId: uuid('default_van_id').references(() => vans.id, { onDelete: 'set null' }),
    workStart: time('work_start').notNull().default('08:00'),
    workEnd: time('work_end').notNull().default('17:00'),
    maxHours: doublePrecision('max_hours').notNull().default(10),
    /** Used when a route ends at the driver's home (RTE-02). */
    homeAddress: text('home_address'),
    homePostcode: text('home_postcode'),
    homeLat: doublePrecision('home_lat'),
    homeLng: doublePrecision('home_lng'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('drivers_user_unique').on(t.userId)],
).enableRLS();

// ---------- customers & orders ----------

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('customers_phone_idx').on(t.phone)],
).enableRLS();

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNumber: text('order_number').notNull(),
    trackingRef: text('tracking_ref').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    town: text('town').notNull(),
    /** Normalised "SW1A 1AA" form. */
    postcode: text('postcode').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    geocodeStatus: geocodeStatusEnum('geocode_status').notNull().default('pending'),
    timeWindowStart: time('time_window_start'),
    timeWindowEnd: time('time_window_end'),
    serviceMinutes: integer('service_minutes').notNull().default(10),
    extraMinutes: integer('extra_minutes').notNull().default(0),
    extraReason: text('extra_reason'),
    requiresSignature: boolean('requires_signature').notNull().default(false),
    accessInstructions: text('access_instructions'),
    deliveryNotes: text('delivery_notes'),
    /** Office-only. Never sent to drivers or the tracking page. */
    internalNotes: text('internal_notes'),
    status: orderStatusEnum('status').notNull().default('awaiting_scheduling'),
    scheduledDate: date('scheduled_date', { mode: 'string' }),
    currentRouteId: uuid('current_route_id').references((): AnyPgColumn => routes.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
    source: orderSourceEnum('source').notNull().default('manual'),
    externalId: text('external_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_order_number_unique').on(t.orderNumber),
    uniqueIndex('orders_tracking_ref_unique').on(t.trackingRef),
    uniqueIndex('orders_source_external_unique').on(t.source, t.externalId).where(sql`${t.externalId} is not null`),
    index('orders_postcode_idx').on(t.postcode),
    index('orders_status_date_idx').on(t.status, t.scheduledDate),
    index('orders_current_route_idx').on(t.currentRouteId),
    index('orders_created_idx').on(t.createdAt.desc(), t.id.desc()),
    index('orders_customer_name_trgm').using('gin', t.customerName.op('gin_trgm_ops')),
    index('orders_address_trgm').using('gin', t.addressLine1.op('gin_trgm_ops')),
    index('orders_phone_trgm').using('gin', t.customerPhone.op('gin_trgm_ops')),
  ],
).enableRLS();

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sku: text('sku'),
    name: text('name').notNull(),
    qty: integer('qty').notNull(),
    deliveredQty: integer('delivered_qty').notNull().default(0),
    /** Load units per item (optimiser capacity demand = units × qty). */
    units: doublePrecision('units').notNull().default(1),
    weightKg: doublePrecision('weight_kg'),
    volumeM3: doublePrecision('volume_m3'),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
).enableRLS();

// ---------- routes ----------

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    depotId: uuid('depot_id')
      .notNull()
      .references(() => depots.id, { onDelete: 'restrict' }),
    endType: routeEndTypeEnum('end_type').notNull().default('depot'),
    driverId: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    vanId: uuid('van_id').references(() => vans.id, { onDelete: 'set null' }),
    status: routeStatusEnum('status').notNull().default('draft'),
    totalMiles: doublePrecision('total_miles'),
    driveMinutes: integer('drive_minutes'),
    totalMinutes: integer('total_minutes'),
    optimisedAt: ts('optimised_at'),
    releasedAt: ts('released_at'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('routes_date_idx').on(t.date), index('routes_driver_date_idx').on(t.driverId, t.date)],
).enableRLS();

export const routeStops = pgTable(
  'route_stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    eta: ts('eta'),
    etaWindowOk: boolean('eta_window_ok'),
    arrivedAt: ts('arrived_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('route_stops_route_seq_idx').on(t.routeId, t.sequence),
    uniqueIndex('route_stops_route_order_unique').on(t.routeId, t.orderId),
    index('route_stops_order_idx').on(t.orderId),
  ],
).enableRLS();

// ---------- delivery attempts & proof ----------

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id').references(() => routes.id, { onDelete: 'set null' }),
    driverId: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    attemptNo: integer('attempt_no').notNull(),
    outcome: attemptOutcomeEnum('outcome').notNull(),
    failureReason: failureReasonEnum('failure_reason'),
    recipientName: text('recipient_name'),
    leftAtType: leftAtTypeEnum('left_at_type'),
    leftAtNote: text('left_at_note'),
    signaturePath: text('signature_path'),
    notes: text('notes'),
    /** Idempotency key generated on the device so offline replays never double-record (DRP-06). */
    clientActionId: uuid('client_action_id'),
    /** When the driver actually completed the stop (may be earlier than created_at if synced late). */
    occurredAt: ts('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('delivery_attempts_order_attempt_unique').on(t.orderId, t.attemptNo),
    uniqueIndex('delivery_attempts_client_action_unique').on(t.clientActionId),
  ],
).enableRLS();

export const attemptPhotos = pgTable(
  'attempt_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => deliveryAttempts.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull(),
    type: photoTypeEnum('type').notNull(),
    takenAt: ts('taken_at'),
    createdAt: createdAt(),
  },
  (t) => [index('attempt_photos_attempt_idx').on(t.attemptId)],
).enableRLS();

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id').references(() => deliveryAttempts.id, { onDelete: 'set null' }),
    type: issueTypeEnum('type').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('issues_order_idx').on(t.orderId)],
).enableRLS();

// ---------- history & tracking ----------

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Null for system/webhook actors. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: roleEnum('actor_role'),
    type: text('type').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    routeId: uuid('route_id'),
    driverId: uuid('driver_id'),
    note: text('note'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_created_idx').on(t.orderId, t.createdAt)],
).enableRLS();

export const driverLocations = pgTable(
  'driver_locations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id').references(() => routes.id, { onDelete: 'set null' }),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    accuracy: doublePrecision('accuracy'),
    recordedAt: ts('recorded_at').notNull(),
  },
  (t) => [
    index('driver_locations_driver_time_idx').on(t.driverId, t.recordedAt.desc()),
    index('driver_locations_recorded_idx').on(t.recordedAt),
  ],
).enableRLS();

// ---------- import ----------

export const importTemplates = pgTable('import_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** { "<spreadsheet column>": "<order field>" } */
  mapping: jsonb('mapping').$type<Record<string, string>>().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileName: text('file_name').notNull(),
  status: importStatusEnum('status').notNull().default('uploaded'),
  mapping: jsonb('mapping').$type<Record<string, string>>(),
  rowsTotal: integer('rows_total').notNull().default(0),
  rowsImported: integer('rows_imported').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  errors: jsonb('errors').$type<{ row: number; message: string }[]>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  committedAt: ts('committed_at'),
}).enableRLS();

// ---------- admin ----------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    ip: text('ip'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt), index('audit_log_actor_idx').on(t.actorId)],
).enableRLS();

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
}).enableRLS();
