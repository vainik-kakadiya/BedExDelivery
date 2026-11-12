import type { LatLng, RoutingEngineKind } from '@bedex/shared';

export type { LatLng };

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** One order to deliver (RTE-04 "shipments"). */
export interface ShipmentSpec {
  orderId: string;
  location: LatLng;
  serviceSeconds: number;
  /** Load units (order_items.units × qty). */
  demand: number;
  window: TimeWindow | null;
}

/** One driver + van for the day (RTE-04 "vehicles"). */
export interface VehicleSpec {
  /** Opaque id the caller uses to map results back (we use driverId). */
  key: string;
  start: LatLng;
  /** null = the route ends at the last stop. */
  end: LatLng | null;
  capacity: number | null;
  /** Driver's working day. */
  startTime: Date;
  endTime: Date;
  maxDurationSeconds: number | null;
}

export interface PlanningModel {
  shipments: ShipmentSpec[];
  vehicles: VehicleSpec[];
}

export interface PlannedVisit {
  orderId: string;
  arrival: Date;
  /** Service start: arrival, or the window opening if the van arrives early. */
  start: Date;
  departure: Date;
}

export interface PlannedRoute {
  vehicleKey: string;
  visits: PlannedVisit[];
  startTime: Date;
  endTime: Date;
  distanceMeters: number;
  travelSeconds: number;
  polyline: string | null;
}

export type SkipReason = 'capacity' | 'time_window' | 'working_hours' | 'no_vehicle' | 'unknown';

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  capacity: 'Too big for any selected van',
  time_window: "Can't reach it within its delivery window",
  working_hours: "Doesn't fit in any driver's working hours",
  no_vehicle: 'No driver/van available',
  unknown: 'Could not be fitted into any route',
};

export interface OptimiseResult {
  routes: PlannedRoute[];
  skipped: { orderId: string; reason: SkipReason }[];
  engine: RoutingEngineKind;
}

export interface Leg {
  meters: number;
  seconds: number;
}

export interface LegsResult {
  legs: Leg[];
  polyline: string | null;
  engine: RoutingEngineKind;
}

/** Everything the planner needs from a routing provider. */
export interface RoutingEngine {
  readonly optimiserKind: RoutingEngineKind;
  readonly travelKind: RoutingEngineKind;
  /** RTE-04: assign and order shipments across vehicles. */
  optimise(model: PlanningModel): Promise<OptimiseResult>;
  /** RTE-07: road distance/time for each consecutive pair of points, in order. */
  legs(points: LatLng[]): Promise<LegsResult>;
}
