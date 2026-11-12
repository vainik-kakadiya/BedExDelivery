/**
 * Every enum used across the API, the database (pgEnum) and the web app.
 * Changing a value here requires a database migration.
 */

export const ROLES = ['admin', 'office', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_SOURCES = ['manual', 'import', 'shopify', 'migration'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const GEOCODE_STATUSES = ['pending', 'ok', 'failed', 'manual'] as const;
export type GeocodeStatus = (typeof GEOCODE_STATUSES)[number];

export const ROUTE_END_TYPES = ['depot', 'driver_home', 'last_stop'] as const;
export type RouteEndType = (typeof ROUTE_END_TYPES)[number];

export const ATTEMPT_OUTCOMES = ['delivered', 'partial', 'failed'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const FAILURE_REASONS = [
  'not_home',
  'wrong_address',
  'refused',
  'access_issue',
  'damaged',
  'missing_parts',
  'van_issue',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  not_home: 'Customer not home',
  wrong_address: 'Wrong address',
  refused: 'Refused',
  access_issue: 'Access issue',
  damaged: 'Damaged',
  missing_parts: 'Missing parts',
  van_issue: 'Van issue',
  other: 'Other',
};

export const LEFT_AT_TYPES = ['customer', 'neighbour', 'safe_place'] as const;
export type LeftAtType = (typeof LEFT_AT_TYPES)[number];

export const ISSUE_TYPES = ['damaged', 'missing_parts', 'other'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const PHOTO_TYPES = ['proof', 'issue'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const IMPORT_STATUSES = ['uploaded', 'mapped', 'committed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
