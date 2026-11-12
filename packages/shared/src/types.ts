import type { AttemptOutcome, FailureReason, OrderSource, Role } from './enums';
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
    status: OrderStatus;
    lat: number;
    lng: number;
  }[];
  depots: { id: string; name: string; lat: number; lng: number }[];
}

export interface DriverOption {
  id: string;
  name: string;
  active: boolean;
}

export interface RouteOption {
  id: string;
  name: string;
  date: string;
  status: RouteStatus;
  driverId: string | null;
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
