import type { Db } from '@bedex/db';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { Env } from './env';
import { ChangeFeed } from './lib/changeFeed';
import { type AuthUser, signAccessToken } from './lib/jwt';
import { createRoutingEngine } from './modules/planning/engine';

const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused',
  DATABASE_POOL_MAX: 1,
  JWT_ACCESS_SECRET: 'test-secret-that-is-definitely-long-enough',
  CORS_ORIGIN: ['http://localhost:5173'],
  COOKIE_SECURE: true,
  TRUST_PROXY: 0,
  SUPABASE_PHOTO_BUCKET: 'delivery-photos',
};

/** Any DB access fails the test: these paths must be rejected before a query runs. */
const untouchableDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`Database accessed unexpectedly (db.${String(prop)})`);
    },
  },
) as unknown as Db;

const routing = createRoutingEngine({});
const makeApp = () =>
  createApp({ db: untouchableDb, env, changes: new ChangeFeed(), routing, storage: null }, { logger: pino({ level: 'silent' }) });

const office: AuthUser = { id: '00000000-0000-4000-8000-000000000001', role: 'office', driverId: null };
const driver: AuthUser = {
  id: '00000000-0000-4000-8000-000000000002',
  role: 'driver',
  driverId: '00000000-0000-4000-8000-000000000003',
};
const bearer = async (user: AuthUser) => `Bearer ${await signAccessToken(env.JWT_ACCESS_SECRET, user)}`;

describe('auth & RBAC', () => {
  const app = makeApp();

  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/v1/orders');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await signAccessToken('another-secret-that-is-also-long-enough!!', office);
    const res = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('forbids drivers from office order endpoints', async () => {
    const res = await request(app).get('/api/v1/orders').set('Authorization', await bearer(driver));
    expect(res.status).toBe(403);
  });

  it('forbids office users from driver endpoints', async () => {
    const res = await request(app).get('/api/v1/driver/routes/today').set('Authorization', await bearer(office));
    expect(res.status).toBe(403);
  });

  it('forbids a driver login with no driver profile from driver endpoints', async () => {
    const orphan = await bearer({ ...driver, driverId: null });
    const res = await request(app).get('/api/v1/driver/routes/today').set('Authorization', orphan);
    expect(res.status).toBe(403);
  });

  it('validates order input before touching the database', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', await bearer(office))
      .send({ orderNumber: 'X1', postcode: 'not a postcode', items: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.fieldErrors).toHaveProperty('postcode');
    expect(res.body.details.fieldErrors).toHaveProperty('items');
  });

  it('returns 404 for a non-uuid order id', async () => {
    const res = await request(app).get('/api/v1/orders/123').set('Authorization', await bearer(office));
    expect(res.status).toBe(404);
  });
});

describe('dashboard & exports RBAC', () => {
  const app = makeApp();
  const officeOnly = [
    '/api/v1/routes/plan?date=2026-11-12',
    '/api/v1/routes/optimise/00000000-0000-4000-8000-000000000009',
    '/api/v1/depots',
    '/api/v1/settings',
    '/api/v1/dashboard/summary',
    '/api/v1/dashboard/live',
    '/api/v1/dashboard/stream',
    '/api/v1/drivers',
    '/api/v1/routes?date=2026-11-12',
    '/api/v1/exports/orders',
    '/api/v1/exports/deliveries?from=2026-11-12&to=2026-11-12',
    '/api/v1/exports/manifest/00000000-0000-4000-8000-000000000009',
  ];

  it.each(officeOnly)('rejects anonymous access to %s', async (path) => {
    expect((await request(app).get(path)).status).toBe(401);
  });

  it.each(officeOnly)('rejects drivers from %s', async (path) => {
    expect((await request(app).get(path).set('Authorization', await bearer(driver))).status).toBe(403);
  });

  it('lets only admins change depots, settings, drivers and vans', async () => {
    const asOffice = await bearer(office);
    const id = '00000000-0000-4000-8000-000000000009';
    for (const [method, path] of [
      ['patch', '/api/v1/settings'],
      ['post', '/api/v1/depots'],
      ['post', '/api/v1/drivers'],
      ['patch', `/api/v1/drivers/${id}`],
      ['post', '/api/v1/vans'],
      ['patch', `/api/v1/vans/${id}`],
      ['get', `/api/v1/vans/${id}/impact`],
      ['post', `/api/v1/vans/${id}/deactivate`],
    ] as const) {
      expect((await request(app)[method](path).set('Authorization', asOffice).send({})).status, `${method} ${path}`).toBe(403);
    }
  });

  it('keeps drivers out of the fleet pages and stop transfers', async () => {
    const asDriver = await bearer(driver);
    for (const path of ['/api/v1/drivers', '/api/v1/drivers/progress', '/api/v1/vans']) {
      expect((await request(app).get(path).set('Authorization', asDriver)).status, path).toBe(403);
    }
    const res = await request(app)
      .post('/api/v1/routes/00000000-0000-4000-8000-000000000009/stops/transfer')
      .set('Authorization', asDriver)
      .send({});
    expect(res.status).toBe(403);
  });

  it('validates a new driver before touching the database', async () => {
    const admin = await bearer({ ...office, role: 'admin' });
    const res = await request(app).post('/api/v1/drivers').set('Authorization', admin).send({ name: 'X', password: 'short' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fieldErrors)).toEqual(expect.arrayContaining(['password', 'workStart', 'workEnd']));
  });

  it('forbids drivers from planner actions', async () => {
    const asDriver = await bearer(driver);
    const id = '00000000-0000-4000-8000-000000000009';
    for (const [method, path] of [
      ['post', '/api/v1/routes/optimise'],
      ['put', `/api/v1/routes/${id}/stops`],
      ['post', `/api/v1/routes/${id}/release`],
      ['delete', `/api/v1/routes/${id}`],
    ] as const) {
      expect((await request(app)[method](path).set('Authorization', asDriver).send({})).status, `${method} ${path}`).toBe(403);
    }
  });

  it('validates optimise requests before touching the database', async () => {
    const res = await request(app)
      .post('/api/v1/routes/optimise')
      .set('Authorization', await bearer(office))
      .send({ date: '2026-11-12', depotId: 'x', endType: 'moon', vehicles: [] });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fieldErrors).sort()).toEqual(['depotId', 'endType', 'vehicles']);
  });

  it('validates export parameters before touching the database', async () => {
    const res = await request(app)
      .get('/api/v1/exports/deliveries?from=2026-11-12&to=2026-11-01&format=docx')
      .set('Authorization', await bearer(office));
    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors).toHaveProperty('format');
  });
});

describe('dashboard stream (DSH-07)', () => {
  it('pushes coalesced change events to connected office users', async () => {
    const changes = new ChangeFeed(5);
    const app = createApp({ db: untouchableDb, env, changes, routing, storage: null }, { logger: pino({ level: 'silent' }) });
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/stream`, {
        headers: { Authorization: await bearer(office) },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      while (!text.includes('event: ready')) text += (await reader.read()).value ?? '';

      changes.publish('orders');
      changes.publish('route_stops');
      while (!text.includes('event: change')) text += (await reader.read()).value ?? '';
      expect(text).toContain('data: {"tables":["orders","route_stops"]}');

      controller.abort();
      await reader.cancel().catch(() => undefined);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('public tracking endpoint', () => {
  it('gives the same generic 404 for malformed input', async () => {
    const res = await request(makeApp()).get('/api/v1/public/track?ref=x');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/couldn't find a delivery/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rate limits to 10 requests per minute per IP (TRK-05)', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get('/api/v1/public/track')).status).toBe(404);
    }
    const res = await request(app).get('/api/v1/public/track');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});

describe('errors', () => {
  it('returns JSON for unknown endpoints', async () => {
    const res = await request(makeApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Endpoint not found' });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(makeApp())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"identifier":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

describe('driver proof of delivery (DRP-05)', () => {
  const app = makeApp();
  const stop = '00000000-0000-4000-8000-0000000000aa';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

  it('keeps office users and anonymous callers out', async () => {
    expect((await request(app).post(`/api/v1/driver/stops/${stop}/photos`).send(jpeg)).status).toBe(401);
    const res = await request(app).post(`/api/v1/driver/stops/${stop}/complete`).set('Authorization', await bearer(office)).send({});
    expect(res.status).toBe(403);
  });

  it('treats a malformed stop id as not found', async () => {
    const res = await request(app).post('/api/v1/driver/stops/not-a-uuid/complete').set('Authorization', await bearer(driver)).send({});
    expect(res.status).toBe(404);
  });

  it('says so when photo storage is not configured', async () => {
    const res = await request(app)
      .post(`/api/v1/driver/stops/${stop}/photos`)
      .set('Authorization', await bearer(driver))
      .set('Content-Type', 'image/jpeg')
      .send(jpeg);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('refuses to complete a delivery without a photo, before touching the database', async () => {
    const res = await request(app)
      .post(`/api/v1/driver/stops/${stop}/complete`)
      .set('Authorization', await bearer(driver))
      .send({ outcome: 'delivered', recipientName: 'Jane', leftAtType: 'customer', photos: [], clientActionId: stop });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('order import (ORD-05)', () => {
  const app = makeApp();

  it('is office-only', async () => {
    const res = await request(app)
      .post('/api/v1/orders/import/parse')
      .set('Authorization', await bearer(driver))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('Order No\nSO-1\n'));
    expect(res.status).toBe(403);
  });

  it('reads an uploaded CSV and suggests a column mapping', async () => {
    const res = await request(app)
      .post('/api/v1/orders/import/parse?fileName=orders.csv')
      .set('Authorization', await bearer(office))
      .set('Content-Type', 'text/csv')
      .send(Buffer.from('Order No,Customer,Postcode\nSO-1,Jane Smith,NW10 4AB\n'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fileName: 'orders.csv',
      sheetName: null,
      headers: ['Order No', 'Customer', 'Postcode'],
      rows: [['SO-1', 'Jane Smith', 'NW10 4AB']],
      suggestedMapping: { orderNumber: 0, customerName: 1, postcode: 2 },
    });
  });

  it('rejects a preview before the required columns are mapped', async () => {
    const res = await request(app)
      .post('/api/v1/orders/import/preview')
      .set('Authorization', await bearer(office))
      .send({ fileName: 'orders.csv', headers: ['Order No'], rows: [['SO-1']], mapping: { orderNumber: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('order delete', () => {
  const app = makeApp();

  it('is office-only', async () => {
    const res = await request(app)
      .post('/api/v1/orders/delete')
      .set('Authorization', await bearer(driver))
      .send({ ids: ['00000000-0000-4000-8000-000000000099'] });
    expect(res.status).toBe(403);
  });

  it('validates the ids before touching the database', async () => {
    const auth = await bearer(office);
    const empty = await request(app).post('/api/v1/orders/delete').set('Authorization', auth).send({ ids: [] });
    expect(empty.status).toBe(400);
    const bad = await request(app).post('/api/v1/orders/delete').set('Authorization', auth).send({ ids: ['not-a-uuid'] });
    expect(bad.status).toBe(400);
  });
});
