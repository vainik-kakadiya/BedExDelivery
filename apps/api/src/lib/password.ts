import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library's OWASP-aligned defaults. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time as a real verify when the user doesn't exist,
 * so response timing doesn't reveal which logins are valid.
 */
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= hash('dummy-password-for-timing');
  await verifyPassword(await dummyHash, plain);
}
