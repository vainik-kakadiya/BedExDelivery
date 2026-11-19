import type { AttemptOutcome, FailureReason, GeocodeStatus, LeftAtType, OrderSource, PhotoType, Role, RouteEndType } from './enums';
import type { OrderStatus, RouteStatus } from './status';

/** Error envelope returned by every API error (PRD §8). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  driverId: string | null;
}

export interface SessionResponse {
  accessToken: string;
  user: SessionUser;
}

export interface OrderDeleteResult {
  deleted: number;
  /** Orders that were kept, with the reason. */
  skipped: { id: string; orderNumber: string; reason: string }[];
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  trackingRef: string;
  customerName: string;
  town: string;
  postcode: string;
  status: OrderStatus;
  scheduledDate: string | null;
  currentRouteId: string | null;
  source: OrderSource;
  geocodeStatus: string;
  createdAt: string;
}

// ---------- order detail (HST-01 – HST-03) ----------

export interface OrderDetailItem {
  id: string;
  sku: string | null;
  name: string;
  qty: number;
  deliveredQty: number;
  units: number;
}

/** GET /orders/:id */
export interface OrderDetail {
  id: string;
  orderNumber: string;
  trackingRef: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  addressLine1: string;
  addressLine2: string | null;
  town: string;
  postcode: string;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  serviceMinutes: number;
  extraMinutes: number;
  extraReason: string | null;
  requiresSignature: boolean;
  accessInstructions: string | null;
  deliveryNotes: string | null;
  internalNotes: string | null;
  status: OrderStatus;
  scheduledDate: string | null;
  currentRouteId: string | null;
  cancelReason: string | null;
  source: OrderSource;
  createdAt: string;
  updatedAt: string;
  items: OrderDetailItem[];
}

export interface OrderAttemptPhoto {
  id: string;
  type: PhotoType;
  /** Short-lived signed link; null when photo storage is not configured or the file is missing. */
  url: string | null;
  takenAt: string | null;
}

export interface OrderAttempt {
  id: string;
  attemptNo: number;
  outcome: AttemptOutcome;
  failureReason: FailureReason | null;
  recipientName: string | null;
  leftAtType: LeftAtType | null;
  leftAtNote: string | null;
  notes: string | null;
  occurredAt: string;
  driverName: string | null;
  routeName: string | null;
  routeDate: string | null;
  photos: OrderAttemptPhoto[];
}

export interface OrderEventItem {
  id: string;
  type: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  note: string | null;
  createdAt: string;
  actorName: string | null;
  actorRole: Role | null;
}

/** GET /orders/:id/history */
export interface OrderHistory {
  /** The route the order is on now, if any. */
  route: {
    id: string;
    name: string;
    date: string;
    status: RouteStatus;
    driverName: string | null;
    vanName: string | null;
    vanRegistration: string | null;
  } | null;
  /** Newest first. */
  attempts: OrderAttempt[];
  /** Oldest first. */
  events: OrderEventItem[];
}

// ---------- dashboard (DSH-01 – DSH-04) ----------

export interface DashboardCards {
  /** Orders not yet on a route: awaiting scheduling, in warehouse, rescheduled. */
  awaitingAllocation: number;
  routesToday: number;
  stopsCompleted: number;
  stopsOutstanding: number;
  /** Attempts on the selected day's routes. */
  failedToday: number;
  partialToday: number;
  /** Failed + partially delivered orders waiting for an office decision (= action queue). */
  needsDecision: number;
}

export interface DashboardRouteRow {
  id: string;
  name: string;
  status: RouteStatus;
  driverId: string | null;
  driverName: string | null;
  vanName: string | null;
  vanRegistration: string | null;
  stopsTotal: number;
  stopsCompleted: number;
  /** Minutes behind (+) or ahead (−) of the planned ETAs; null before the route has timing data. */
  etaDriftMinutes: number | null;
  lastUpdateAt: string | null;
}

export interface ActionQueueItem {
  orderId: string;
  orderNumber: string;
  customerName: string;
  town: string;
  postcode: string;
  status: OrderStatus;
  attemptNo: number | null;
  outcome: AttemptOutcome | null;
  failureReason: FailureReason | null;
  attemptNotes: string | null;
  attemptAt: string | null;
  driverName: string | null;
}

export interface DashboardSummary {
  date: string;
  cards: DashboardCards;
  routes: DashboardRouteRow[];
  actionQueue: ActionQueueItem[];
}

export interface DashboardLive {
  date: string;
  drivers: {
    driverId: string;
    name: string;
    routeId: string | null;
    routeName: string | null;
    lat: number;
    lng: number;
    recordedAt: string;
  }[];
  stops: {
    stopId: string;
    routeId: string;
    routeName: string;
    sequence: number;
    orderId: string;
    orderNumber: string;
    customerName: string;
    postcode: string;
    status: OrderStatus;
    eta: string | null;
    completedAt: string | null;
    lat: number;
    lng: number;
  }[];
  /** One per route that day, sorted by name like the planner, so colours match. */
  routes: LiveRoute[];
  depots: { id: string; name: string; lat: number; lng: number }[];
}

/** DSH-03: one van's day on the tracking map. */
export interface LiveRoute {
  routeId: string;
  name: string;
  status: RouteStatus;
  driverId: string | null;
  driverName: string | null;
  vanName: string | null;
  vanRegistration: string | null;
  depotId: string;
  endType: RouteEndType;
  /** Planned road path; null when timings are estimated (draw straight lines). */
  polyline: string | null;
  stopsTotal: number;
  stopsCompleted: number;
  /** The first stop not finished yet: where the van is heading. */
  nextStop: { stopId: string; sequence: number; postcode: string; customerName: string; eta: string | null } | null;
  /** ETA at the last stop still to do (or when the last one was finished). */
  lastStopEta: string | null;
  /** Back at the depot / driver's home. */
  plannedEnd: string | null;
  /** Finished stops in the order they were done. */
  done: { stopId: string; sequence: number; postcode: string; status: OrderStatus; completedAt: string | null }[];
  /**
   * Where the van is: the latest GPS fix from the driver app, or the last
   * finished stop if that is more recent. Null before the route starts.
   */
  position: { lat: number; lng: number; at: string; source: 'gps' | 'stop'; accuracy: number | null } | null;
}

export interface DriverOption {
  id: string;
  name: string;
  active: boolean;
}

/** DRV-01. Superset of DriverOption, so the same endpoint feeds filters. */
export interface DriverDto extends DriverOption {
  userId: string;
  email: string | null;
  phone: string | null;
  workStart: string;
  workEnd: string;
  maxHours: number;
  defaultVanId: string | null;
  defaultVanName: string | null;
  homeAddress: string | null;
  homePostcode: string | null;
  homeLat: number | null;
  homeLng: number | null;
  lastLoginAt: string | null;
}

/** DRV-02. */
export interface VanDto {
  id: string;
  registration: string;
  name: string;
  capacityUnits: number;
  capacityKg: number | null;
  capacityM3: number | null;
  active: boolean;
  /** Drivers who use this van by default. */
  defaultFor: string[];
}

/** DRV-04: one driver's day. */
export interface DriverProgressStop {
  stopId: string;
  sequence: number;
  orderId: string;
  orderNumber: string;
  customerName: string;
  postcode: string;
  status: OrderStatus;
  eta: string | null;
  completedAt: string | null;
}

export interface DriverProgressRoute {
  routeId: string;
  name: string;
  status: RouteStatus;
  vanId: string | null;
  vanName: string | null;
  stopsTotal: number;
  stopsCompleted: number;
  /** First stop not yet completed (the one the driver is heading to). */
  currentStop: DriverProgressStop | null;
  stops: DriverProgressStop[];
}

export interface DriverProgress {
  driverId: string;
  name: string;
  active: boolean;
  routes: DriverProgressRoute[];
  lastLocation: { lat: number; lng: number; recordedAt: string } | null;
}

export interface RouteOption {
  id: string;
  name: string;
  date: string;
  status: RouteStatus;
  driverId: string | null;
}

// ---------- depots & route planning (RTE-*) ----------

export interface Depot {
  id: string;
  name: string;
  address: string;
  postcode: string;
  lat: number;
  lng: number;
  isDefault: boolean;
  active: boolean;
}

export type RoutingEngineKind = 'google' | 'estimate';

export interface PlannerOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  addressLine1: string;
  town: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  /** 'pending' while the address is being looked up; 'failed' when it couldn't be found. */
  geocodeStatus: GeocodeStatus;
  status: OrderStatus;
  scheduledDate: string | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  /** Base + extra minutes. */
  serviceMinutes: number;
  loadUnits: number;
  loadKg: number;
  loadM3: number;
}

export interface PlannerStop {
  id: string;
  sequence: number;
  eta: string | null;
  etaWindowOk: boolean | null;
  order: PlannerOrder;
}

export type RouteWarningCode =
  | 'over_capacity'
  | 'outside_window'
  | 'over_hours'
  | 'no_driver'
  | 'no_van'
  | 'missing_geocode'
  | 'empty'
  | 'no_home_location'
  | 'unassigned';

export interface RouteWarning {
  code: RouteWarningCode;
  message: string;
  orderIds?: string[];
}

export interface PlannerRoute {
  id: string;
  name: string;
  status: RouteStatus;
  depotId: string;
  endType: RouteEndType;
  driverId: string | null;
  driverName: string | null;
  vanId: string | null;
  vanName: string | null;
  vanRegistration: string | null;
  capacityUnits: number | null;
  loadUnits: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  totalMiles: number | null;
  driveMinutes: number | null;
  totalMinutes: number | null;
  polyline: string | null;
  engine: RoutingEngineKind | null;
  optimisedAt: string | null;
  releasedAt: string | null;
  /** Stops can be changed (draft or released, not yet started). */
  editable: boolean;
  stops: PlannerStop[];
  warnings: RouteWarning[];
}

export interface PlannerDriver {
  id: string;
  name: string;
  defaultVanId: string | null;
  workStart: string;
  workEnd: string;
  maxHours: number;
  hasHomeLocation: boolean;
  /** Released / in-progress routes this driver already has on the date. */
  busyRouteNames: string[];
}

export interface PlannerVan {
  id: string;
  name: string;
  registration: string;
  capacityUnits: number;
  capacityKg: number | null;
  capacityM3: number | null;
}

export interface PlannerState {
  date: string;
  engines: { optimiser: RoutingEngineKind; travel: RoutingEngineKind };
  depots: Depot[];
  defaultDepotId: string | null;
  defaultEndType: RouteEndType;
  drivers: PlannerDriver[];
  vans: PlannerVan[];
  routes: PlannerRoute[];
  /** Eligible orders not on any route for the date (RTE-01). */
  unassigned: PlannerOrder[];
  warnings: RouteWarning[];
}

export interface OptimiseSkipped {
  orderId: string;
  orderNumber: string;
  reason: string;
}

export interface OptimiseJob {
  id: string;
  date: string;
  status: 'running' | 'done' | 'failed';
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: { routeIds: string[]; skipped: OptimiseSkipped[]; engine: RoutingEngineKind } | null;
}

/** Everything the public tracking page is allowed to see (TRK-03/04). */
export interface PublicTracking {
  trackingRef: string;
  status: OrderStatus;
  statusLabel: string;
  deliveryDate: string | null;
  timeWindow: { from: string; to: string } | null;
  timeline: { status: OrderStatus; label: string; at: string }[];
}
