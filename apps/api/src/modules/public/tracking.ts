import { ORDER_STATUS_META, type OrderStatus, type PublicTracking, formatTime } from '@bedex/shared';

export interface TrackableOrder {
  trackingRef: string;
  status: OrderStatus;
  scheduledDate: string | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  /**
   * Whether the order's route has been released to a driver. Planners save
   * draft routes and change them freely, so until release the customer sees
   * the order as not yet booked.
   */
  routeReleased: boolean;
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
  let history = events.filter((e): e is TrackableEvent & { toStatus: OrderStatus } => e.toStatus !== null);
  let status = order.status;

  // On a draft route only: show the status the order had before it was planned.
  if (status === 'scheduled' && !order.routeReleased) {
    while (history.at(-1)?.toStatus === 'scheduled') history = history.slice(0, -1);
    status = history.at(-1)?.toStatus ?? 'awaiting_scheduling';
    if (status === 'scheduled') status = 'awaiting_scheduling';
  }

  const timeline: PublicTracking['timeline'] = [];
  for (const e of history) {
    if (!ORDER_STATUS_META[e.toStatus].customerTimeline) continue;
    // Collapse repeats such as two consecutive "scheduled" events after a route edit.
    if (timeline.at(-1)?.status === e.toStatus) continue;
    timeline.push({ status: e.toStatus, label: ORDER_STATUS_META[e.toStatus].customerLabel, at: e.createdAt.toISOString() });
  }

  return {
    trackingRef: order.trackingRef,
    status,
    statusLabel: ORDER_STATUS_META[status].customerLabel,
    deliveryDate: NO_DATE_STATUSES.includes(status) ? null : order.scheduledDate,
    timeWindow:
      order.timeWindowStart && order.timeWindowEnd
        ? { from: formatTime(order.timeWindowStart), to: formatTime(order.timeWindowEnd) }
        : null,
    timeline,
  };
}
