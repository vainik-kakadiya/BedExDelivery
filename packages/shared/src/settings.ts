/** Keys and defaults for the `settings` table (admin-editable). */
export const DEFAULT_SETTINGS = {
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
