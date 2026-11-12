import type { RouteEndType } from './enums';

/** Keys and defaults for the `settings` table (admin-editable). */
export const DEFAULT_SETTINGS = {
  /** RTE-02: where routes end unless changed per route. */
  'routes.defaultEndType': 'depot' as RouteEndType,
  /** TRK-03: show the proof-of-delivery photo on the public tracking page. */
  'tracking.showProofPhoto': false,
  /** TRK-04: show the driver's first name on the public tracking page. */
  'tracking.showDriverName': false,
  /** TRK-04: show live van location (GPS add-on). */
  'tracking.showLiveLocation': false,
  'orders.defaultServiceMinutes': 10,
  /** ORD-06: window for postcode + phone + product duplicate detection. */
  'import.duplicateWindowDays': 14,
  /** DRP-08: GPS ping interval while a route is in progress. */
  'driver.locationIntervalSeconds': 45,
  /** GDPR retention (PRD §10). */
  'retention.driverLocationDays': 30,
  'retention.photoDays': 365,
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof DEFAULT_SETTINGS)[K] };

/** Labels for the Settings page. */
export const SETTING_LABELS: Record<SettingKey, string> = {
  'routes.defaultEndType': 'Routes end at',
  'tracking.showProofPhoto': 'Show proof-of-delivery photo on the tracking page',
  'tracking.showDriverName': "Show the driver's first name on the tracking page",
  'tracking.showLiveLocation': 'Show live van location on the tracking page (GPS add-on)',
  'orders.defaultServiceMinutes': 'Default service time per stop (minutes)',
  'import.duplicateWindowDays': 'Duplicate check window for imports (days)',
  'driver.locationIntervalSeconds': 'Driver GPS ping interval (seconds)',
  'retention.driverLocationDays': 'Keep driver locations for (days)',
  'retention.photoDays': 'Keep delivery photos for (days)',
};
