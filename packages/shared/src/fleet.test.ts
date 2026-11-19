import { describe, expect, it } from 'vitest';
import { driverCreateSchema, driverUpdateSchema, stopTransferSchema, vanDeactivateSchema, vanSchema } from './schemas';

const driver = {
  name: 'Alex Morgan',
  email: 'Alex@Example.com',
  password: 'a-long-enough-password',
  workStart: '07:30',
  workEnd: '17:30',
  maxHours: 10,
};

describe('driverCreateSchema (DRV-01)', () => {
  it('normalises login fields and accepts optional extras as null', () => {
    const parsed = driverCreateSchema.parse({ ...driver, phone: '07700 900123', defaultVanId: '', homeLat: '', homeLng: '' });
    expect(parsed.email).toBe('alex@example.com');
    expect(parsed.phone).toBe('+447700900123');
    expect(parsed.defaultVanId).toBeNull();
    expect(parsed.homeLat).toBeNull();
  });

  it('needs an email or phone to log in with', () => {
    expect(driverCreateSchema.safeParse({ ...driver, email: '' }).success).toBe(false);
    expect(driverCreateSchema.safeParse({ ...driver, email: '', phone: '07700900123' }).success).toBe(true);
  });

  it('requires a strong-enough password and sensible hours', () => {
    expect(driverCreateSchema.safeParse({ ...driver, password: 'short' }).success).toBe(false);
    expect(driverCreateSchema.safeParse({ ...driver, workStart: '18:00' }).success).toBe(false);
    expect(driverCreateSchema.safeParse({ ...driver, maxHours: 20 }).success).toBe(false);
  });

  it('wants both home coordinates or neither', () => {
    expect(driverCreateSchema.safeParse({ ...driver, homeLat: 51.5 }).success).toBe(false);
    expect(driverCreateSchema.safeParse({ ...driver, homeLat: 51.5, homeLng: -0.2, homePostcode: 'w12 7ja' }).data?.homePostcode).toBe('W12 7JA');
  });
});

describe('driverUpdateSchema', () => {
  it('treats a blank password as "keep the current one"', () => {
    expect(driverUpdateSchema.parse({ password: '' })).toEqual({});
    expect(driverUpdateSchema.safeParse({ password: 'short' }).success).toBe(false);
  });

  it('allows (de)activation on its own', () => {
    expect(driverUpdateSchema.parse({ active: false })).toEqual({ active: false });
  });
});

describe('vanSchema (DRV-02)', () => {
  it('normalises the registration', () => {
    expect(vanSchema.parse({ registration: ' ab12  cde ', name: 'Luton 1', capacityUnits: 40 }).registration).toBe('AB12 CDE');
  });

  it('needs a positive unit capacity; kg and m³ are optional', () => {
    expect(vanSchema.safeParse({ registration: 'AB12CDE', name: 'X', capacityUnits: 0 }).success).toBe(false);
    const parsed = vanSchema.parse({ registration: 'AB12CDE', name: 'X', capacityUnits: 25, capacityKg: '', capacityM3: '12.5' });
    expect(parsed.capacityKg).toBeNull();
    expect(parsed.capacityM3).toBe(12.5);
  });
});

describe('stopTransferSchema (DRV-05)', () => {
  it('needs at least one stop and no duplicates', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const to = '00000000-0000-4000-8000-000000000002';
    expect(stopTransferSchema.safeParse({ orderIds: [], toRouteId: to }).success).toBe(false);
    expect(stopTransferSchema.safeParse({ orderIds: [id, id], toRouteId: to }).success).toBe(false);
    expect(stopTransferSchema.safeParse({ orderIds: [id], toRouteId: to }).success).toBe(true);
  });
});

describe('vanDeactivateSchema (DRV-02)', () => {
  const route = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';

  it('accepts no routes and an empty reason', () => {
    expect(vanDeactivateSchema.parse({ reason: '' })).toEqual({ reason: null, routes: [] });
  });

  it('needs the van or route each action points to', () => {
    expect(vanDeactivateSchema.safeParse({ routes: [{ routeId: route, action: 'swap' }] }).success).toBe(false);
    expect(vanDeactivateSchema.safeParse({ routes: [{ routeId: route, action: 'transfer' }] }).success).toBe(false);
    expect(vanDeactivateSchema.safeParse({ routes: [{ routeId: route, action: 'swap', vanId: other }] }).success).toBe(true);
    expect(vanDeactivateSchema.safeParse({ routes: [{ routeId: route, action: 'transfer', toRouteId: other }] }).success).toBe(true);
    expect(vanDeactivateSchema.safeParse({ routes: [{ routeId: route, action: 'scrap' }] }).success).toBe(false);
  });

  it('allows one decision per route', () => {
    const twice = [
      { routeId: route, action: 'unplan' },
      { routeId: route, action: 'unassign' },
    ];
    expect(vanDeactivateSchema.safeParse({ routes: twice }).success).toBe(false);
  });
});
