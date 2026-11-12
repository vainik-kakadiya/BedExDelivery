import { ORDER_STATUS_META, type OrderStatus, type PublicTracking, formatTime } from '@bedex/shared';

export interface TrackableOrder {
  trackingRef: string;
  status: OrderStatus;
  scheduledDate: string | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
}

export interface TrackableEvent {
  toStatus: OrderStatus | null;
  createdAt: Date;
}

/** No date to show the customer while the order isn't booked onto a day. */
const NO_DATE_STATUSES: readonly OrderStatus[] = ['awaiting_scheduling', 'in_warehouse', 'returned_to_warehouse', 'cancelled'];

/**
 * Build the public tracking payload field by field (never by spreading the
 * order) so new internal columns can't leak to customers (TRK-03/04).
 */
export function toPublicTracking(order: TrackableOrder, events: TrackableEvent[]): PublicTracking {
  const timeline: PublicTracking['timeline'] = [];
  for (const e of events) {
    if (!e.toStatus || !ORDER_STATUS_META[e.toStatus].customerTimeline) continue;
    // Collapse repeats such as two consecutive "scheduled" events after a route edit.
    if (timeline.at(-1)?.status === e.toStatus) continue;
    timeline.push({ status: e.toStatus, label: ORDER_STATUS_META[e.toStatus].customerLabel, at: e.createdAt.toISOString() });
  }

  return {
    trackingRef: order.trackingRef,
    status: order.status,
    statusLabel: ORDER_STATUS_META[order.status].customerLabel,
    deliveryDate: NO_DATE_STATUSES.includes(order.status) ? null : order.scheduledDate,
    timeWindow:
      order.timeWindowStart && order.timeWindowEnd
        ? { from: formatTime(order.timeWindowStart), to: formatTime(order.timeWindowEnd) }
        : null,
    timeline,
  };
}
