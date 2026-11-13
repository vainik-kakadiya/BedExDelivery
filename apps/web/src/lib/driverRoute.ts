import type { OrderStatus } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface DriverStop {
  id: string;
  sequence: number;
  eta: string | null;
  completedAt: string | null;
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    customerName: string;
    customerPhone: string | null;
    addressLine1: string;
    addressLine2: string | null;
    town: string;
    postcode: string;
    lat: number | null;
    lng: number | null;
    timeWindowStart: string | null;
    timeWindowEnd: string | null;
    accessInstructions: string | null;
    deliveryNotes: string | null;
    requiresSignature: boolean;
    items: { id: string; sku: string | null; name: string; qty: number; deliveredQty: number }[];
  };
}

export interface DriverRoute {
  id: string;
  name: string;
  status: string;
  /** Set when the office edits the route after release (RTE-09). */
  changedAt: string | null;
  stops: DriverStop[];
}

export interface TodayResponse {
  date: string;
  routes: DriverRoute[];
}

export const DRIVER_TODAY_KEY = ['driver', 'today'] as const;

/** Today's routes for the signed-in driver; shared by both tabs and the tab counts. */
export function useDriverToday() {
  return useQuery({ queryKey: DRIVER_TODAY_KEY, queryFn: () => api<TodayResponse>('/driver/routes/today') });
}

/** Statuses that mean the driver has finished with a stop, whatever the outcome. */
const FINISHED: readonly OrderStatus[] = ['delivered', 'partially_delivered', 'failed', 'returned_to_warehouse', 'cancelled'];

export const findStop = (data: TodayResponse | undefined, stopId: string) => {
  for (const route of data?.routes ?? []) {
    const stop = route.stops.find((s) => s.id === stopId);
    if (stop) return { route, stop };
  }
  return null;
};

export const isFinished = (stop: DriverStop) => stop.completedAt !== null || FINISHED.includes(stop.order.status);

export function countStops(data: TodayResponse | undefined) {
  const stops = data?.routes.flatMap((r) => r.stops) ?? [];
  const done = stops.filter(isFinished).length;
  return { todo: stops.length - done, done };
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
export const hhmm = (iso: string) => timeFormat.format(new Date(iso));

export const formatAddress = (o: DriverStop['order']) =>
  `${o.addressLine1}${o.addressLine2 ? `, ${o.addressLine2}` : ''}, ${o.town} ${o.postcode}`;

export function navigateUrl(o: DriverStop['order']): string {
  const destination = o.lat != null && o.lng != null ? `${o.lat},${o.lng}` : `${o.addressLine1}, ${o.town}, ${o.postcode}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
