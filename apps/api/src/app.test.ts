import type { Db } from '@bedex/db';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { Env } from './env';
import { ChangeFeed } from './lib/changeFeed';
import { type AuthUser, signAccessToken } from './lib/jwt';

const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused',
  JWT_ACCESS_SECRET: 'test-secret-that-is-definitely-long-enough',
  CORS_ORIGIN: ['http://localhost:5173'],
  COOKIE_SECURE: true,
  TRUST_PROXY: 0,
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

const makeApp = () => createApp({ db: untouchableDb, env, changes: new ChangeFeed() }, { logger: pino({ level: 'silent' }) });

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
    const app = createApp({ db: untouchableDb, env, changes }, { logger: pino({ level: 'silent' }) });
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
