import { LONDON_TZ } from '@bedex/shared';
import { sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * SQL condition: `column` falls on the given Europe/London calendar date(s).
 * Expressed as a half-open range so the timestamp index can be used.
 */
export function onLondonDates(column: PgColumn, from: string, to: string = from) {
  return sql`${column} >= (${from}::date::timestamp at time zone ${LONDON_TZ}) and ${column} < ((${to}::date + 1)::timestamp at time zone ${LONDON_TZ})`;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "14:05" in Europe/London. */
export const londonTime = (d: Date | null | undefined) => (d ? timeFmt.format(d) : '');
/** "12/11/2026, 14:05" in Europe/London. */
export const londonDateTime = (d: Date | null | undefined) => (d ? dateTimeFmt.format(d) : '');
