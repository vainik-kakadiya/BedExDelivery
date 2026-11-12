import { ROLES, type Role } from '@bedex/shared';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'bedex-api';
const AUDIENCE = 'bedex-portal';

export interface AuthUser {
  id: string;
  role: Role;
  /** drivers.id for driver users, otherwise null. All driver endpoints scope on this. */
  driverId: string | null;
}

const claimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(ROLES),
  did: z.string().uuid().nullable(),
});

const keyFor = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(secret: string, user: AuthUser): Promise<string> {
  return new SignJWT({ role: user.role, did: user.driverId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(keyFor(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, keyFor(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  const claims = claimsSchema.parse(payload);
  return { id: claims.sub, role: claims.role, driverId: claims.did };
}
