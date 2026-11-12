/**
 * Demo data for trying the dashboard and exports.
 *
 *   pnpm db:seed:demo           replace any previous demo data with a fresh set
 *   pnpm db:seed:demo --reset   remove demo data only
 *
 * Everything is tagged so it can be removed without touching real data:
 * orders "DEMO-…", routes "DEMO …", vans "DEMO…", depot "DEMO …",
 * driver logins "…@demo.bedex.invalid" (random passwords: nobody can sign in).
 * Times are relative to now, so "today" always has routes in progress.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { type FailureReason, type OrderStatus, generateTrackingRef, toLondonDate } from '@bedex/shared';
import { config } from 'dotenv';
import { eq, inArray, like } from 'drizzle-orm';
import {
  type Db,
  createDb,
  deliveryAttempts,
  depots,
  driverLocations,
  drivers,
  orderEvents,
  orderItems,
  orders,
  routeStops,
  routes,
  users,
  vans,
} from './index';

config({ path: ['../../.env', '.env'] });

const DEMO_EMAIL_DOMAIN = '@demo.bedex.invalid';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// Deterministic randomness so re-runs look the same.
let seed = 20261112;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const AREAS = [
  { district: 'NW10', lat: 51.543, lng: -0.255 },
  { district: 'W3', lat: 51.509, lng: -0.268 },
  { district: 'W5', lat: 51.513, lng: -0.304 },
  { district: 'HA0', lat: 51.552, lng: -0.297 },
  { district: 'NW2', lat: 51.558, lng: -0.218 },
  { district: 'W12', lat: 51.507, lng: -0.231 },
  { district: 'SW6', lat: 51.475, lng: -0.2 },
  { district: 'SW11', lat: 51.465, lng: -0.163 },
  { district: 'SE1', lat: 51.5, lng: -0.09 },
  { district: 'E14', lat: 51.505, lng: -0.02 },
  { district: 'N7', lat: 51.553, lng: -0.117 },
  { district: 'E8', lat: 51.544, lng: -0.064 },
  { district: 'SW19', lat: 51.421, lng: -0.205 },
  { district: 'CR0', lat: 51.375, lng: -0.098 },
  { district: 'TW8', lat: 51.486, lng: -0.305 },
  { district: 'UB6', lat: 51.536, lng: -0.344 },
] as const;
const FIRST = ['Olivia', 'Amelia', 'Isla', 'Ava', 'Mia', 'Jack', 'Oliver', 'Harry', 'George', 'Noah', 'Aisha', 'Mohammed', 'Priya', 'Chen', 'Sofia', 'Tom'];
const LAST = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Patel', 'Khan', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright', 'Hughes'];
const STREETS = ['High Street', 'Church Road', 'Station Road', 'Park Avenue', 'Victoria Road', 'Green Lane', 'Manor Way', 'Kings Road', 'Queens Gardens', 'Mill Lane'];
const PRODUCTS = [
  'King size bed frame',
  'Double divan base',
  'Memory foam mattress (king)',
  'Pocket sprung mattress (double)',
  'Upholstered headboard',
  'Ottoman storage bed',
  'Bedside table',
  'Two-door wardrobe',
];
const ACCESS = [null, null, 'Gate code 4821', 'Flat on 3rd floor, no lift', 'Use side entrance', null, 'Narrow stairs – two-person lift'];
const WINDOWS: [string | null, string | null][] = [
  ['08:00', '12:00'],
  ['12:00', '18:00'],
  [null, null],
  ['10:00', '14:00'],
];

const LETTERS = 'ABDEFGHJLNPQRSTUWXYZ';

interface OrderSpec {
  status: OrderStatus;
  scheduledDate: string | null;
  createdAt: Date;
}

let orderSeq = 1000;
function buildOrder(spec: OrderSpec) {
  const area = pick(AREAS);
  const first = pick(FIRST);
  const [from, to] = pick(WINDOWS);
  orderSeq += 1;
  return {
    orderNumber: `DEMO-${orderSeq}`,
    trackingRef: generateTrackingRef(),
    customerName: `${first} ${pick(LAST)}`,
    customerPhone: `+447700900${String(between(100, 999))}`,
    customerEmail: `${first.toLowerCase()}${orderSeq}@example.com`,
    addressLine1: `${between(1, 180)} ${pick(STREETS)}`,
    town: 'London',
    postcode: `${area.district} ${between(1, 9)}${pick([...LETTERS])}${pick([...LETTERS])}`,
    lat: area.lat + (rand() - 0.5) * 0.02,
    lng: area.lng + (rand() - 0.5) * 0.03,
    geocodeStatus: 'ok' as const,
    timeWindowStart: from,
    timeWindowEnd: to,
    serviceMinutes: 15,
    extraMinutes: rand() < 0.2 ? 20 : 0,
    extraReason: null as string | null,
    requiresSignature: rand() < 0.3,
    accessInstructions: pick(ACCESS),
    deliveryNotes: rand() < 0.25 ? 'Customer asked for a call 30 min before' : null,
    status: spec.status,
    scheduledDate: spec.scheduledDate,
    source: 'manual' as const,
    createdAt: spec.createdAt,
  };
}

type StopPlan =
  | { kind: 'delivered'; lateBy: number }
  | { kind: 'failed'; lateBy: number; reason: FailureReason; note: string }
  | { kind: 'partial'; lateBy: number }
  | { kind: 'pending' };

interface RoutePlan {
  name: string;
  date: string;
  status: 'released' | 'in_progress' | 'completed';
  start: Date;
  intervalMin: number;
  stops: StopPlan[];
  /** Index into the drivers/vans arrays. */
  crew: number;
  miles: number;
}

async function reset(db: Db) {
  const demoUsers = await db.select({ id: users.id }).from(users).where(like(users.email, `%${DEMO_EMAIL_DOMAIN}`));
  const userIds = demoUsers.map((u) => u.id);
  await db.delete(routes).where(like(routes.name, 'DEMO %'));
  await db.delete(orders).where(like(orders.orderNumber, 'DEMO-%'));
  if (userIds.length) {
    await db.delete(drivers).where(inArray(drivers.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(vans).where(like(vans.registration, 'DEMO%'));
  await db.delete(depots).where(like(depots.name, 'DEMO %'));
}

async function seedDemo(db: Db) {
  const now = new Date();
  const today = toLondonDate(now);
  const yesterday = toLondonDate(new Date(now.getTime() - DAY));
  const tomorrow = toLondonDate(new Date(now.getTime() + DAY));

  // --- depot, vans, drivers ---
  const hasDefault = await db.select({ id: depots.id }).from(depots).where(eq(depots.isDefault, true)).limit(1);
  const [depot] = await db
    .insert(depots)
    .values({
      name: 'DEMO Depot – Park Royal',
      address: 'Unit 4, Abbey Road Industrial Estate, London',
      postcode: 'NW10 7SU',
      lat: 51.529,
      lng: -0.267,
      isDefault: hasDefault.length === 0,
    })
    .returning();
  if (!depot) throw new Error('Depot insert failed');

  const vanRows = await db
    .insert(vans)
    .values([
      { registration: 'DEMO1 BDX', name: 'Luton 1', capacityUnits: 40, capacityKg: 1000, capacityM3: 18 },
      { registration: 'DEMO2 BDX', name: 'Luton 2', capacityUnits: 40, capacityKg: 1000, capacityM3: 18 },
      { registration: 'DEMO3 BDX', name: 'Transit 3', capacityUnits: 25, capacityKg: 800, capacityM3: 12 },
    ])
    .returning();

  const crewNames = ['Alex Morgan', 'Sam Okafor', 'Priya Shah'];
  const driverRows = [];
  for (const [i, name] of crewNames.entries()) {
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name.split(' ')[0]!.toLowerCase()}${DEMO_EMAIL_DOMAIN}`,
        role: 'driver',
        // Random, never disclosed: demo drivers can't sign in.
        passwordHash: await hash(randomBytes(24).toString('base64url')),
      })
      .returning();
    const [driver] = await db
      .insert(drivers)
      .values({ userId: user!.id, defaultVanId: vanRows[i]!.id, workStart: '07:30', workEnd: '17:30' })
      .returning();
    driverRows.push({ ...driver!, userId: user!.id, name });
  }

  // --- routes and their orders ---
  const plans: RoutePlan[] = [
    {
      name: 'DEMO North',
      date: today,
      status: 'in_progress',
      start: new Date(now.getTime() - 180 * MIN),
      intervalMin: 25,
      crew: 0,
      miles: 41.7,
      stops: [
        { kind: 'delivered', lateBy: 2 },
        { kind: 'delivered', lateBy: -3 },
        { kind: 'delivered', lateBy: 4 },
        { kind: 'delivered', lateBy: 1 },
        { kind: 'failed', lateBy: 5, reason: 'not_home', note: 'No answer, calling card left' },
        { kind: 'partial', lateBy: 6 },
        { kind: 'pending' },
        { kind: 'pending' },
        { kind: 'pending' },
        { kind: 'pending' },
      ],
    },
    {
      name: 'DEMO West',
      date: today,
      status: 'in_progress',
      start: new Date(now.getTime() - 120 * MIN),
      intervalMin: 30,
      crew: 1,
      miles: 36.2,
      stops: [
        { kind: 'delivered', lateBy: 22 },
        { kind: 'delivered', lateBy: 25 },
        { kind: 'delivered', lateBy: 27 },
        ...Array.from({ length: 6 }, () => ({ kind: 'pending' }) as const),
      ],
    },
    {
      name: 'DEMO South',
      date: today,
      status: 'released',
      start: new Date(now.getTime() + 20 * MIN),
      intervalMin: 25,
      crew: 2,
      miles: 33.9,
      stops: Array.from({ length: 8 }, () => ({ kind: 'pending' }) as const),
    },
    {
      name: 'DEMO Yesterday',
      date: yesterday,
      status: 'completed',
      start: new Date(now.getTime() - DAY - 240 * MIN),
      intervalMin: 30,
      crew: 0,
      miles: 18.4,
      stops: [
        { kind: 'delivered', lateBy: 0 },
        { kind: 'failed', lateBy: 3, reason: 'access_issue', note: 'Gate locked, no answer on intercom' },
        { kind: 'failed', lateBy: 8, reason: 'not_home', note: 'Neighbour unwilling to accept' },
      ],
    },
  ];

  let created = 0;
  for (const plan of plans) {
    const crew = driverRows[plan.crew]!;
    const van = vanRows[plan.crew]!;
    const completedCount = plan.stops.filter((s) => s.kind !== 'pending').length;
    const [route] = await db
      .insert(routes)
      .values({
        name: plan.name,
        date: plan.date,
        depotId: depot.id,
        driverId: crew.id,
        vanId: van.id,
        status: plan.status,
        totalMiles: plan.miles,
        driveMinutes: Math.round(plan.miles * 2.6),
        totalMinutes: plan.stops.length * plan.intervalMin + 30,
        optimisedAt: new Date(plan.start.getTime() - 14 * 60 * MIN),
        releasedAt: new Date(plan.start.getTime() - 12 * 60 * MIN),
        startedAt: plan.status === 'released' ? null : plan.start,
        completedAt:
          plan.status === 'completed' ? new Date(plan.start.getTime() + (plan.stops.length + 1) * plan.intervalMin * MIN) : null,
      })
      .returning();
    if (!route) throw new Error('Route insert failed');

    let lastDone: { lat: number; lng: number } | null = null;
    let nextStop: { lat: number; lng: number } | null = null;

    for (const [i, stop] of plan.stops.entries()) {
      const eta = new Date(plan.start.getTime() + (i + 1) * plan.intervalMin * MIN);
      const completedAt = stop.kind === 'pending' ? null : new Date(eta.getTime() + stop.lateBy * MIN);
      const status: OrderStatus =
        stop.kind === 'delivered'
          ? 'delivered'
          : stop.kind === 'failed'
            ? 'failed'
            : stop.kind === 'partial'
              ? 'partially_delivered'
              : plan.status === 'released'
                ? 'scheduled'
                : 'out_for_delivery';
      const createdAt = new Date(plan.start.getTime() - between(2, 6) * DAY);
      const values = buildOrder({ status, scheduledDate: plan.date, createdAt });
      if (values.extraMinutes) values.extraReason = 'Assembly';
      const [order] = await db.insert(orders).values({ ...values, currentRouteId: route.id }).returning();
      if (!order) throw new Error('Order insert failed');
      created += 1;

      const itemCount = stop.kind === 'partial' ? 2 : between(1, 2);
      const items = Array.from({ length: itemCount }, (_, k) => ({
        orderId: order.id,
        sku: `SKU-${between(100, 999)}`,
        name: k === 0 && stop.kind === 'partial' ? 'King size bed frame' : pick(PRODUCTS),
        qty: 1,
        deliveredQty: stop.kind === 'delivered' ? 1 : stop.kind === 'partial' && k === 0 ? 1 : 0,
        units: between(2, 6),
      }));
      await db.insert(orderItems).values(items);

      await db.insert(routeStops).values({
        routeId: route.id,
        orderId: order.id,
        sequence: i + 1,
        eta,
        etaWindowOk: true,
        arrivedAt: completedAt ? new Date(completedAt.getTime() - 9 * MIN) : null,
        completedAt,
      });

      // History: created → scheduled → out for delivery → outcome.
      const scheduledAt = new Date(plan.start.getTime() - 14 * 60 * MIN);
      const events: (typeof orderEvents.$inferInsert)[] = [
        { orderId: order.id, type: 'created', toStatus: 'awaiting_scheduling', payload: { source: 'demo' }, createdAt },
        {
          orderId: order.id,
          type: 'status_changed',
          fromStatus: 'awaiting_scheduling',
          toStatus: 'scheduled',
          routeId: route.id,
          createdAt: scheduledAt,
        },
      ];
      if (plan.status !== 'released') {
        events.push({
          orderId: order.id,
          actorId: crew.userId,
          actorRole: 'driver',
          type: 'status_changed',
          fromStatus: 'scheduled',
          toStatus: 'out_for_delivery',
          routeId: route.id,
          driverId: crew.id,
          createdAt: plan.start,
        });
      }

      if (stop.kind !== 'pending' && completedAt) {
        const first = values.customerName.split(' ')[0];
        await db.insert(deliveryAttempts).values({
          orderId: order.id,
          routeId: route.id,
          driverId: crew.id,
          attemptNo: 1,
          outcome: stop.kind === 'partial' ? 'partial' : stop.kind,
          failureReason: stop.kind === 'failed' ? stop.reason : null,
          recipientName: stop.kind === 'failed' ? null : first,
          leftAtType: stop.kind === 'failed' ? null : 'customer',
          notes: stop.kind === 'failed' ? stop.note : stop.kind === 'partial' ? 'Headboard missing from van, rest delivered' : null,
          clientActionId: randomUUID(),
          occurredAt: completedAt,
        });
        events.push({
          orderId: order.id,
          actorId: crew.userId,
          actorRole: 'driver',
          type: 'status_changed',
          fromStatus: 'out_for_delivery',
          toStatus: status,
          routeId: route.id,
          driverId: crew.id,
          createdAt: completedAt,
        });
        lastDone = { lat: values.lat, lng: values.lng };
      } else if (!nextStop) {
        nextStop = { lat: values.lat, lng: values.lng };
      }
      await db.insert(orderEvents).values(events);
    }

    // Breadcrumb of GPS pings for routes on the road today (DRP-08 data for DSH-03).
    if (plan.status === 'in_progress' && plan.date === today) {
      const from = lastDone ?? { lat: depot.lat, lng: depot.lng };
      const to = nextStop ?? from;
      const pings = 6;
      await db.insert(driverLocations).values(
        Array.from({ length: pings }, (_, k) => {
          const f = (k + 1) / (pings + 1);
          return {
            driverId: crew.id,
            routeId: route.id,
            lat: from.lat + (to.lat - from.lat) * f,
            lng: from.lng + (to.lng - from.lng) * f,
            accuracy: between(5, 20),
            recordedAt: new Date(now.getTime() - (pings - k) * (plan.crew === 0 ? 1 : 2) * MIN),
          };
        }),
      );
    }
    console.log(`  ${plan.name} (${plan.date}, ${plan.status}): ${plan.stops.length} stops, ${completedCount} completed`);
  }

  // --- orders not yet on a route ---
  const unallocated: OrderSpec[] = [
    ...Array.from({ length: 4 }, () => ({ status: 'awaiting_scheduling' as const, scheduledDate: null, createdAt: new Date(now.getTime() - between(1, 3) * DAY) })),
    ...Array.from({ length: 2 }, () => ({ status: 'in_warehouse' as const, scheduledDate: null, createdAt: new Date(now.getTime() - 4 * DAY) })),
    { status: 'rescheduled', scheduledDate: tomorrow, createdAt: new Date(now.getTime() - 6 * DAY) },
  ];
  for (const spec of unallocated) {
    const [order] = await db.insert(orders).values(buildOrder(spec)).returning();
    if (!order) throw new Error('Order insert failed');
    created += 1;
    await db.insert(orderItems).values({ orderId: order.id, name: pick(PRODUCTS), qty: between(1, 2), units: between(2, 6) });
    await db.insert(orderEvents).values({
      orderId: order.id,
      type: 'created',
      toStatus: 'awaiting_scheduling',
      payload: { source: 'demo' },
      createdAt: spec.createdAt,
    });
  }
  console.log(`  ${unallocated.length} orders awaiting allocation`);
  return created;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const resetOnly = process.argv.includes('--reset');
  const { db, client } = createDb(url, { max: 1 });
  try {
    await db.transaction(async (tx) => {
      await reset(tx as unknown as Db);
      if (resetOnly) {
        console.log('Removed demo data.');
        return;
      }
      console.log('Creating demo data:');
      const n = await seedDemo(tx as unknown as Db);
      console.log(`Done – ${n} demo orders. Remove with: pnpm db:seed:demo --reset`);
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
