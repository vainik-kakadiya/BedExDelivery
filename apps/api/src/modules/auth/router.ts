import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type DbOrTx, refreshTokens, users } from '@bedex/db';
import { loginSchema, normalisePhone, type SessionResponse, type SessionUser } from '@bedex/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type CookieOptions, type Request, type Response, Router } from 'express';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { AppError, unauthorized } from '../../lib/errors';
import { signAccessToken } from '../../lib/jwt';
import { verifyAgainstDummy, verifyPassword } from '../../lib/password';
import { currentUser, requireAuth } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';

const REFRESH_COOKIE = 'bedex_rt';
/** Sliding window: each refresh issues a fresh 30-day token, so active users stay signed in. */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Two tabs refreshing at the same moment both present the same token. A reuse
 * this soon after rotation is treated as that race, not theft.
 */
const REUSE_GRACE_MS = 10_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function authRouter({ db, env }: AppContext) {
  const router = Router();

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/v1/auth',
  };
  const setRefreshCookie = (res: Response, raw: string) =>
    res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions, maxAge: REFRESH_TTL_MS });
  const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, cookieOptions);
  const readRefreshCookie = (req: Request): string | null => {
    const raw: unknown = req.cookies?.[REFRESH_COOKIE];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };

  /** Null if the user (or, for drivers, their driver profile) is deactivated. */
  async function loadSessionUser(userId: string): Promise<SessionUser | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: { driver: { columns: { id: true, active: true } } },
    });
    if (!user?.active) return null;
    if (user.role === 'driver' && !user.driver?.active) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      driverId: user.driver?.id ?? null,
    };
  }

  async function createRefreshToken(tx: DbOrTx, userId: string, familyId: string, userAgent: string | undefined) {
    const raw = randomBytes(32).toString('base64url');
    const [row] = await tx
      .insert(refreshTokens)
      .values({
        userId,
        familyId,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: userAgent?.slice(0, 300),
      })
      .returning({ id: refreshTokens.id });
    if (!row) throw new Error('Failed to create refresh token');
    return { raw, id: row.id };
  }

  const revokeFamily = (familyId: string) =>
    db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));

  const accessTokenFor = (user: SessionUser) =>
    signAccessToken(env.JWT_ACCESS_SECRET, { id: user.id, role: user.role, driverId: user.driverId });

  // ---- POST /auth/login ----
  router.post(
    '/login',
    limiter({ windowMs: 60_000, limit: 10, message: 'Too many sign-in attempts. Please wait a minute.' }),
    async (req, res) => {
      const { identifier, password } = loginSchema.parse(req.body);
      const where = identifier.includes('@')
        ? sql`lower(${users.email}) = ${identifier.toLowerCase()}`
        : eq(users.phone, normalisePhone(identifier));
      const user = await db.query.users.findFirst({ where });
      const invalid = unauthorized('Incorrect email/phone or password', 'INVALID_CREDENTIALS');

      if (!user) {
        await verifyAgainstDummy(password);
        throw invalid;
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        const [row] = await db
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
          .where(eq(users.id, user.id))
          .returning({ failed: users.failedLoginCount });
        const locked = (row?.failed ?? 0) >= MAX_FAILED_LOGINS;
        if (locked) {
          await db
            .update(users)
            .set({ failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MS) })
            .where(eq(users.id, user.id));
        }
        await audit(db, req, { action: locked ? 'login_locked' : 'login_failed', actorId: user.id, entity: 'user', entityId: user.id });
        throw invalid;
      }

      const sessionUser = await loadSessionUser(user.id);
      if (!sessionUser) {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated. Please contact the office.');
      }

      await db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      const refresh = await createRefreshToken(db, user.id, randomUUID(), req.get('user-agent'));
      await audit(db, req, { action: 'login', actorId: user.id, entity: 'user', entityId: user.id });

      setRefreshCookie(res, refresh.raw);
      res.json({ accessToken: await accessTokenFor(sessionUser), user: sessionUser } satisfies SessionResponse);
    },
  );

  // ---- POST /auth/refresh (rotation + reuse detection) ----
  router.post('/refresh', limiter({ windowMs: 60_000, limit: 30 }), async (req, res) => {
    const raw = readRefreshCookie(req);
    if (!raw) throw unauthorized('Please sign in', 'NO_SESSION');

    const token = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(raw)) });
    if (!token) {
      clearRefreshCookie(res);
      throw unauthorized('Please sign in', 'NO_SESSION');
    }

    if (token.revokedAt) {
      if (Date.now() - token.revokedAt.getTime() < REUSE_GRACE_MS) {
        // Another tab just rotated it; that tab's cookie is now current, so don't clear it.
        throw unauthorized('Session refresh in progress, retry', 'REFRESH_RACE');
      }
      await revokeFamily(token.familyId);
      await audit(db, req, { action: 'refresh_token_reuse', actorId: token.userId, entity: 'user', entityId: token.userId });
      clearRefreshCookie(res);
      throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_REVOKED');
    }

    if (token.expiresAt <= new Date()) {
      clearRefreshCookie(res);
      throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
    }

    const sessionUser = await loadSessionUser(token.userId);
    if (!sessionUser) {
      await revokeFamily(token.familyId);
      clearRefreshCookie(res);
      throw unauthorized('This account has been deactivated.', 'ACCOUNT_INACTIVE');
    }

    const next = await db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, token.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (!revoked) throw unauthorized('Session refresh in progress, retry', 'REFRESH_RACE');
      const created = await createRefreshToken(tx, token.userId, token.familyId, req.get('user-agent'));
      await tx.update(refreshTokens).set({ replacedById: created.id }).where(eq(refreshTokens.id, token.id));
      return created;
    });

    setRefreshCookie(res, next.raw);
    res.json({ accessToken: await accessTokenFor(sessionUser), user: sessionUser } satisfies SessionResponse);
  });

  // ---- POST /auth/logout ----
  router.post('/logout', async (req, res) => {
    const raw = readRefreshCookie(req);
    if (raw) {
      const token = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(raw)) });
      if (token) {
        await revokeFamily(token.familyId);
        await audit(db, req, { action: 'logout', actorId: token.userId, entity: 'user', entityId: token.userId });
      }
    }
    clearRefreshCookie(res);
    res.status(204).end();
  });

  // ---- GET /auth/me ----
  router.get('/me', requireAuth(env.JWT_ACCESS_SECRET), async (req, res) => {
    const user = await loadSessionUser(currentUser(req).id);
    if (!user) throw unauthorized('This account has been deactivated.', 'ACCOUNT_INACTIVE');
    res.json({ user });
  });

  return router;
}
