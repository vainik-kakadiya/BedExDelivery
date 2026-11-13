import type { Role } from './enums';

/** PRD §6 – order status machine. */
export const ORDER_STATUSES = [
  'awaiting_scheduling',
  'in_warehouse',
  'scheduled',
  'out_for_delivery',
  'delivered',
  'partially_delivered',
  'failed',
  'rescheduled',
  'returned_to_warehouse',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  awaiting_scheduling: ['in_warehouse', 'scheduled', 'cancelled'],
  in_warehouse: ['scheduled', 'cancelled'],
  scheduled: ['out_for_delivery', 'awaiting_scheduling', 'rescheduled', 'cancelled'],
  out_for_delivery: ['delivered', 'partially_delivered', 'failed'],
  delivered: [],
  partially_delivered: ['rescheduled', 'returned_to_warehouse', 'delivered'],
  failed: ['rescheduled', 'returned_to_warehouse'],
  rescheduled: ['scheduled', 'cancelled'],
  returned_to_warehouse: ['rescheduled', 'in_warehouse', 'cancelled'],
  cancelled: [],
};

/** Final statuses can only be reopened by an admin. */
export const FINAL_ORDER_STATUSES: readonly OrderStatus[] = ['delivered', 'cancelled'];
export const REOPEN_TARGET: OrderStatus = 'awaiting_scheduling';

/**
 * Drivers may only make the moves that happen on the road or at depot check-in
 * (DRP-03, DRP-05, DRP-09). Everything else is an office decision.
 */
const DRIVER_TRANSITIONS: Readonly<Partial<Record<OrderStatus, readonly OrderStatus[]>>> = {
  scheduled: ['out_for_delivery'],
  out_for_delivery: ['delivered', 'partially_delivered', 'failed'],
  partially_delivered: ['returned_to_warehouse'],
  failed: ['returned_to_warehouse'],
};

export type TransitionCheck = { ok: true; reopen: boolean } | { ok: false; reason: string };

/**
 * Orders in these statuses can be deleted outright (e.g. entered or imported by
 * mistake), provided they were never on a route and have no delivery attempts.
 * Anything further along keeps its history: cancel it instead.
 */
export const DELETABLE_ORDER_STATUSES: readonly OrderStatus[] = ['awaiting_scheduling', 'in_warehouse', 'cancelled'];

export function isFinalStatus(status: OrderStatus): boolean {
  return FINAL_ORDER_STATUSES.includes(status);
}

export function checkTransition(from: OrderStatus, to: OrderStatus, role: Role): TransitionCheck {
  const fromLabel = ORDER_STATUS_META[from].label;
  const toLabel = ORDER_STATUS_META[to].label;

  if (from === to) return { ok: false, reason: `Order is already "${fromLabel}"` };

  if (isFinalStatus(from)) {
    if (role === 'admin' && to === REOPEN_TARGET) return { ok: true, reopen: true };
    return {
      ok: false,
      reason: `"${fromLabel}" is final; only an admin can reopen it (to "${ORDER_STATUS_META[REOPEN_TARGET].label}")`,
    };
  }

  const allowed = role === 'driver' ? (DRIVER_TRANSITIONS[from] ?? []) : ORDER_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `Cannot move an order from "${fromLabel}" to "${toLabel}"` };
  }
  return { ok: true, reopen: false };
}

export type StatusTone = 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Wording on the public tracking page. */
  customerLabel: string;
  /** Shown as a step on the customer-facing timeline (TRK-03). */
  customerTimeline: boolean;
}

export const ORDER_STATUS_META: Readonly<Record<OrderStatus, StatusMeta>> = {
  awaiting_scheduling: { label: 'Awaiting scheduling', tone: 'neutral', customerLabel: 'Order received', customerTimeline: true },
  in_warehouse: { label: 'In warehouse', tone: 'neutral', customerLabel: 'Preparing for delivery', customerTimeline: false },
  scheduled: { label: 'Scheduled / assigned', tone: 'brand', customerLabel: 'Delivery scheduled', customerTimeline: true },
  out_for_delivery: { label: 'Out for delivery', tone: 'info', customerLabel: 'Out for delivery', customerTimeline: true },
  delivered: { label: 'Delivered', tone: 'success', customerLabel: 'Delivered', customerTimeline: true },
  partially_delivered: { label: 'Partially delivered', tone: 'warning', customerLabel: 'Partially delivered', customerTimeline: true },
  failed: { label: 'Failed delivery', tone: 'danger', customerLabel: 'Delivery attempted', customerTimeline: true },
  rescheduled: { label: 'Rescheduled', tone: 'warning', customerLabel: 'Delivery rescheduled', customerTimeline: true },
  returned_to_warehouse: { label: 'Returned to warehouse', tone: 'neutral', customerLabel: 'Awaiting new delivery date', customerTimeline: false },
  cancelled: { label: 'Cancelled', tone: 'muted', customerLabel: 'Cancelled', customerTimeline: true },
};

/** PRD RTE-09 – route states. */
export const ROUTE_STATUSES = ['draft', 'released', 'in_progress', 'completed'] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

export const ROUTE_TRANSITIONS: Readonly<Record<RouteStatus, readonly RouteStatus[]>> = {
  draft: ['released'],
  released: ['in_progress', 'draft'],
  in_progress: ['completed'],
  completed: [],
};

export function canTransitionRoute(from: RouteStatus, to: RouteStatus): boolean {
  return ROUTE_TRANSITIONS[from].includes(to);
}
