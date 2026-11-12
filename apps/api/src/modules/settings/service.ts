import { type DbOrTx, settings } from '@bedex/db';
import { DEFAULT_SETTINGS, ROUTE_END_TYPES, type SettingKey, type Settings } from '@bedex/shared';
import { badRequest } from '../../lib/errors';

const isKey = (k: string): k is SettingKey => Object.hasOwn(DEFAULT_SETTINGS, k);

/** All settings: stored values over defaults. Unknown or mistyped rows are ignored. */
export async function getSettings(db: DbOrTx): Promise<Settings> {
  const rows = await db.select().from(settings);
  const out = { ...DEFAULT_SETTINGS } as Settings;
  for (const row of rows) {
    if (isKey(row.key) && typeof row.value === typeof DEFAULT_SETTINGS[row.key]) {
      (out as Record<string, unknown>)[row.key] = row.value;
    }
  }
  return out;
}

/** Validate a partial update against each setting's type and allowed values. */
export function validateSettingsPatch(patch: Record<string, string | number | boolean>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!isKey(key)) {
      errors[key] = ['Unknown setting'];
      continue;
    }
    const expected = typeof DEFAULT_SETTINGS[key];
    if (typeof value !== expected) errors[key] = [`Must be a ${expected}`];
    else if (key === 'routes.defaultEndType' && !ROUTE_END_TYPES.includes(value as never)) errors[key] = ['Unknown end location'];
    else if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 100_000)) errors[key] = ['Out of range'];
    else out[key] = value;
  }
  if (Object.keys(errors).length) throw badRequest('Some settings are invalid', { fieldErrors: errors });
  return out as Partial<Settings>;
}

export async function saveSettings(db: DbOrTx, patch: Partial<Settings>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}
