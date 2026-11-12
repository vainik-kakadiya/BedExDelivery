/**
 * Tracking references: "BDX" + 9 characters from an alphabet without
 * look-alikes (no 0/O, 1/I). 32^9 ≈ 3.5e13 combinations, so references
 * can't practically be guessed (TRK-05) and collisions are negligible.
 * Legacy references migrated from the old site are stored as-is.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TRACKING_REF_PREFIX = 'BDX';
const BODY_LENGTH = 9;

export function generateTrackingRef(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  const bytes = random(new Uint8Array(BODY_LENGTH));
  let body = '';
  // 256 is a multiple of 32, so `% 32` has no modulo bias.
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  return TRACKING_REF_PREFIX + body;
}

/** Normalise user input before lookup: trim, uppercase, drop spaces. */
export function normaliseTrackingRef(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}
