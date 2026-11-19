import {
  type Db,
  type Tx,
  auditLog,
  driverLocations,
  drivers,
  orders,
  refreshTokens,
  routeStops,
  routes,
  users,
  vans,
} from '@bedex/db';
import type {
  DriverCreateInput,
  DriverDto,
  DriverProgress,
  DriverUpdateInput,
  VanDto,
  VanInput,
} from '@bedex/shared';
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import type { AuthUser } from '../../lib/jwt';
import { hashPassword } from '../../lib/password';
import { onLondonDates } from '../../lib/time';

/** Routes a driver or van is committed to: released or on the road, today or later. */
const ACTIVE_ROUTE_STATUSES = ['released', 'in_progress'] as const;

async function audit(tx: Tx | Db, actor: AuthUser, action: string, entity: string, entityId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ actorId: actor.id, action, entity, entityId, details });
}

// ---------- drivers (DRV-01) ----------

const driverColumns = {
  id: drivers.id,
  userId: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  driverActive: drivers.active,
  userActive: users.active,
  workStart: drivers.workStart,
  workEnd: drivers.workEnd,
  maxHours: drivers.maxHours,
  defaultVanId: drivers.defaultVanId,
  defaultVanName: vans.name,
  homeAddress: drivers.homeAddress,
  homePostcode: drivers.homePostcode,
  homeLat: drivers.homeLat,
  homeLng: drivers.homeLng,
  lastLoginAt: users.lastLoginAt,
};

function selectDrivers(db: Db | Tx) {
  return db.select(driverColumns).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).leftJoin(vans, eq(vans.id, drivers.defaultVanId));
}

type DriverRow = Awaited<ReturnType<ReturnType<typeof selectDrivers>['execute']>>[number];

const toDriverDto = (r: DriverRow): DriverDto => ({
  id: r.id,
  userId: r.userId,
  name: r.name,
  email: r.email,
  phone: r.phone,
  active: r.driverActive && r.userActive,
  workStart: r.workStart.slice(0, 5),
  workEnd: r.workEnd.slice(0, 5),
  maxHours: r.maxHours,
  defaultVanId: r.defaultVanId,
  defaultVanName: r.defaultVanName,
  homeAddress: r.homeAddress,
  homePostcode: r.homePostcode,
  homeLat: r.homeLat,
  homeLng: r.homeLng,
  lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
});

export async function listDrivers(db: Db): Promise<DriverDto[]> {
  const rows = await selectDrivers(db).orderBy(desc(drivers.active), asc(users.name));
  return rows.map(toDriverDto);
}

async function getDriver(db: Db | Tx, id: string): Promise<DriverDto> {
  const [row] = await selectDrivers(db).where(eq(drivers.id, id));
  if (!row) throw notFound('Driver not found');
  return toDriverDto(row);
}

/** Logins must be unique across all users (admins and office staff too). */
async function assertLoginFree(tx: Tx, email: string | null | undefined, phone: string | null | undefined, exceptUserId: string | null) {
  const clauses = [];
  if (email) clauses.push(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  if (phone) clauses.push(eq(users.phone, phone));
  if (!clauses.length) return;
  const [clash] = await tx
    .select({ email: users.email, phone: users.phone })
    .from(users)
    .where(and(or(...clauses), exceptUserId ? ne(users.id, exceptUserId) : undefined));
  if (clash) {
    const field = email && clash.email?.toLowerCase() === email.toLowerCase() ? 'email' : 'phone';
    throw new AppError(409, 'LOGIN_TAKEN', `Another user already signs in with that ${field}`, { fieldErrors: { [field]: ['Already in use'] } });
  }
}

async function assertVanUsable(tx: Tx, vanId: string | null | undefined) {
  if (!vanId) return;
  const [van] = await tx.select({ active: vans.active }).from(vans).where(eq(vans.id, vanId));
  if (!van?.active) throw badRequest('That van is not active');
}

/** Released or started routes from `today` on, for a driver or van. */
async function committedRoutes(tx: Tx, today: string, by: { driverId?: string; vanId?: string }) {
  return tx
    .select({ name: routes.name, date: routes.date })
    .from(routes)
    .where(
      and(
        by.driverId ? eq(routes.driverId, by.driverId) : eq(routes.vanId, by.vanId!),
        inArray(routes.status, [...ACTIVE_ROUTE_STATUSES]),
        gte(routes.date, today),
      ),
    )
    .orderBy(asc(routes.date));
}

export async function createDriver(db: Db, input: DriverCreateInput, actor: AuthUser): Promise<DriverDto> {
  const passwordHash = await hashPassword(input.password);
  const id = await db.transaction(async (tx) => {
    await assertLoginFree(tx, input.email, input.phone, null);
    await assertVanUsable(tx, input.defaultVanId);
    const [user] = await tx
      .insert(users)
      .values({ name: input.name, email: input.email ?? null, phone: input.phone ?? null, role: 'driver', passwordHash })
      .returning({ id: users.id });
    const [driver] = await tx
      .insert(drivers)
      .values({
        userId: user!.id,
        defaultVanId: input.defaultVanId,
        workStart: input.workStart,
        workEnd: input.workEnd,
        maxHours: input.maxHours,
        homeAddress: input.homeAddress ?? null,
        homePostcode: input.homePostcode ?? null,
        homeLat: input.homeLat,
        homeLng: input.homeLng,
      })
      .returning({ id: drivers.id });
    await audit(tx, actor, 'driver_created', 'driver', driver!.id, { name: input.name, login: input.email ?? input.phone });
    return driver!.id;
  });
  return getDriver(db, id);
}

export async function updateDriver(db: Db, id: string, input: DriverUpdateInput, actor: AuthUser, today: string): Promise<DriverDto> {
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ driver: drivers, email: users.email, phone: users.phone })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .where(eq(drivers.id, id))
      .for('update');
    if (!current) throw notFound('Driver not found');
    const userId = current.driver.userId;

    const email = input.email === undefined ? current.email : input.email;
    const phone = input.phone === undefined ? current.phone : input.phone;
    if (!email && !phone) throw badRequest('A driver needs an email or a phone number to sign in with');
    await assertLoginFree(tx, input.email, input.phone, userId);
    await assertVanUsable(tx, input.defaultVanId);

    const merged = {
      workStart: input.workStart ?? current.driver.workStart.slice(0, 5),
      workEnd: input.workEnd ?? current.driver.workEnd.slice(0, 5),
    };
    if (merged.workStart >= merged.workEnd) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', { fieldErrors: { workEnd: ['Finish must be after start'] } });
    }

    if (input.active === false && current.driver.active) {
      const busy = await committedRoutes(tx, today, { driverId: id });
      if (busy.length) {
        throw conflict('DRIVER_BUSY', `Reassign ${busy.map((r) => `${r.name} (${r.date})`).join(', ')} before deactivating this driver`);
      }
    }

    await tx
      .update(users)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(passwordHash && { passwordHash, failedLoginCount: 0, lockedUntil: null }),
        ...(input.active !== undefined && { active: input.active }),
      })
      .where(eq(users.id, userId));

    const { name: _n, email: _e, phone: _p, password: _pw, active, ...driverFields } = input;
    await tx
      .update(drivers)
      .set({ ...driverFields, ...(active !== undefined && { active }) })
      .where(eq(drivers.id, id));

    // Deactivation or a password reset signs the driver out everywhere (DRV-01).
    // Their current access token expires within 15 minutes; refresh is refused at once.
    if (input.active === false || passwordHash) {
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    }

    const changed = Object.keys(input).filter((k) => k !== 'password');
    await audit(tx, actor, input.active === false ? 'driver_deactivated' : input.active === true ? 'driver_reactivated' : 'driver_updated', 'driver', id, {
      changed,
      ...(passwordHash && { passwordReset: true }),
    });
  });
  return getDriver(db, id);
}

// ---------- vans (DRV-02) ----------

export async function listVans(db: Db): Promise<VanDto[]> {
  const [vanRows, defaults] = await Promise.all([
    db.select().from(vans).orderBy(desc(vans.active), asc(vans.name)),
    db
      .select({ vanId: drivers.defaultVanId, name: users.name })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .where(eq(drivers.active, true)),
  ]);
  return vanRows.map((v) => ({
    id: v.id,
    registration: v.registration,
    name: v.name,
    capacityUnits: v.capacityUnits,
    capacityKg: v.capacityKg,
    capacityM3: v.capacityM3,
    active: v.active,
    defaultFor: defaults.filter((d) => d.vanId === v.id).map((d) => d.name),
  }));
}

async function assertRegistrationFree(tx: Tx, registration: string, exceptId: string | null) {
  const [clash] = await tx
    .select({ id: vans.id })
    .from(vans)
    .where(and(sql`replace(${vans.registration}, ' ', '') = ${registration.replace(/\s/g, '')}`, exceptId ? ne(vans.id, exceptId) : undefined));
  if (clash) {
    throw new AppError(409, 'REGISTRATION_TAKEN', 'A van with that registration already exists', { fieldErrors: { registration: ['Already in use'] } });
  }
}

export async function createVan(db: Db, input: VanInput, actor: AuthUser): Promise<string> {
  return db.transaction(async (tx) => {
    await assertRegistrationFree(tx, input.registration, null);
    const [van] = await tx.insert(vans).values(input).returning({ id: vans.id });
    await audit(tx, actor, 'van_created', 'van', van!.id, { registration: input.registration });
    return van!.id;
  });
}

export async function updateVan(db: Db, id: string, input: Partial<VanInput>, actor: AuthUser, today: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(vans).where(eq(vans.id, id)).for('update');
    if (!current) throw notFound('Van not found');
    if (input.registration) await assertRegistrationFree(tx, input.registration, id);
    if (input.active === false && current.active) {
      // Drafts count too: they would otherwise keep a van that can't be released.
      // Vans with routes go through POST /vans/:id/deactivate, which rehomes them.
      const busy = await tx
        .select({ name: routes.name, date: routes.date })
        .from(routes)
        .where(and(eq(routes.vanId, id), inArray(routes.status, ['draft', ...ACTIVE_ROUTE_STATUSES]), gte(routes.date, today)))
        .orderBy(asc(routes.date));
      if (busy.length) {
        throw conflict('VAN_BUSY', `Decide what happens to ${busy.map((r) => `${r.name} (${r.date})`).join(', ')} before deactivating this van`);
      }
    }
    await tx.update(vans).set(input).where(eq(vans.id, id));
    const action = input.active === false ? 'van_deactivated' : input.active === true && !current.active ? 'van_reactivated' : 'van_updated';
    await audit(tx, actor, action, 'van', id, { changed: Object.keys(input) });
  });
}

// ---------- progress (DRV-04) ----------

export async function getDriverProgress(db: Db, date: string): Promise<DriverProgress[]> {
  const [driverRows, routeRows, pings] = await Promise.all([
    db
      .select({ id: drivers.id, name: users.name, active: drivers.active, userActive: users.active })
      .from(drivers)
      .innerJoin(users, eq(users.id, drivers.userId))
      .orderBy(asc(users.name)),
    // Drafts are invisible to drivers, so they aren't "progress".
    db
      .select({ id: routes.id, name: routes.name, status: routes.status, driverId: routes.driverId, vanId: routes.vanId, vanName: vans.name })
      .from(routes)
      .leftJoin(vans, eq(vans.id, routes.vanId))
      .where(and(eq(routes.date, date), ne(routes.status, 'draft')))
      .orderBy(asc(routes.name)),
    db
      .selectDistinctOn([driverLocations.driverId], {
        driverId: driverLocations.driverId,
        lat: driverLocations.lat,
        lng: driverLocations.lng,
        recordedAt: driverLocations.recordedAt,
      })
      .from(driverLocations)
      .where(onLondonDates(driverLocations.recordedAt, date))
      .orderBy(driverLocations.driverId, desc(driverLocations.recordedAt)),
  ]);

  const routeIds = routeRows.map((r) => r.id);
  const stopRows = routeIds.length
    ? await db
        .select({
          stopId: routeStops.id,
          routeId: routeStops.routeId,
          sequence: routeStops.sequence,
          eta: routeStops.eta,
          completedAt: routeStops.completedAt,
          orderId: orders.id,
          orderNumber: orders.orderNumber,
          customerName: orders.customerName,
          postcode: orders.postcode,
          status: orders.status,
        })
        .from(routeStops)
        .innerJoin(orders, eq(orders.id, routeStops.orderId))
        .where(inArray(routeStops.routeId, routeIds))
        .orderBy(asc(routeStops.sequence))
    : [];

  return driverRows
    .map((d) => {
      const own = routeRows.filter((r) => r.driverId === d.id);
      const ping = pings.find((p) => p.driverId === d.id);
      return {
        driverId: d.id,
        name: d.name,
        active: d.active && d.userActive,
        lastLocation: ping ? { lat: ping.lat, lng: ping.lng, recordedAt: ping.recordedAt.toISOString() } : null,
        routes: own.map((r) => {
          const stops = stopRows
            .filter((s) => s.routeId === r.id)
            .map((s) => ({
              stopId: s.stopId,
              sequence: s.sequence,
              orderId: s.orderId,
              orderNumber: s.orderNumber,
              customerName: s.customerName,
              postcode: s.postcode,
              status: s.status,
              eta: s.eta?.toISOString() ?? null,
              completedAt: s.completedAt?.toISOString() ?? null,
            }));
          const completed = stops.filter((s) => s.completedAt).length;
          return {
            routeId: r.id,
            name: r.name,
            status: r.status,
            vanId: r.vanId,
            vanName: r.vanName,
            stopsTotal: stops.length,
            stopsCompleted: completed,
            currentStop: r.status === 'in_progress' ? (stops.find((s) => !s.completedAt) ?? null) : null,
            stops,
          };
        }),
      };
    })
    .filter((d) => d.active || d.routes.length > 0);
}
