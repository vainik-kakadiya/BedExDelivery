/** UK formatting and normalisation helpers (PRD §10). */

const UK_POSTCODE = /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/;

/** Uppercase with all whitespace removed – the value to compare postcodes on. */
export function postcodeKey(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function isValidUkPostcode(input: string): boolean {
  return UK_POSTCODE.test(postcodeKey(input));
}

/** "sw1a1aa" → "SW1A 1AA". Returns null if it isn't a UK postcode. */
export function normalisePostcode(input: string): string | null {
  const key = postcodeKey(input);
  if (!UK_POSTCODE.test(key)) return null;
  return `${key.slice(0, -3)} ${key.slice(-3)}`;
}

/** Case- and space-insensitive comparison (TRK-02). */
export function postcodesMatch(a: string, b: string): boolean {
  return postcodeKey(a) === postcodeKey(b);
}

/**
 * Normalise phone numbers so search and login behave consistently.
 * UK numbers become E.164 (+44…); anything else keeps its digits and leading +.
 */
export function normalisePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  if (digits.startsWith('44') && digits.length >= 12) return `+${digits}`;
  return digits;
}

export const LONDON_TZ = 'Europe/London';

/** Calendar date (YYYY-MM-DD) in Europe/London for the given instant. */
export function toLondonDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes London is ahead of UTC at the given instant (0 in winter, 60 in summer). */
export function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Wall-clock time in London on a date → the UTC instant. ("2026-07-01", "08:00") → 07:00Z. */
export function londonToUtc(isoDate: string, time: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - londonOffsetMinutes(new Date(guess)) * 60_000;
  // Re-check in case the guess and the answer straddle a clock change.
  const offset = londonOffsetMinutes(new Date(utc));
  utc = guess - offset * 60_000;
  return new Date(utc);
}

/** "2026-11-12" → "12/11/2026". */
export function formatUkDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** "09:30:00" → "09:30". */
export function formatTime(time: string): string {
  return time.slice(0, 5);
}

const KM_PER_MILE = 1.609344;
export function metresToMiles(metres: number): number {
  return metres / 1000 / KM_PER_MILE;
}
