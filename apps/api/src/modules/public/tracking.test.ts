import { describe, expect, it } from 'vitest';
import { toPublicTracking } from './tracking';

// A full order row including fields that must never reach the public page.
const fullOrder = {
  id: 'f3a1c1de-0000-4000-8000-000000000001',
  trackingRef: 'BDXABCDEFGHJ',
  orderNumber: 'SO-1001',
  status: 'out_for_delivery' as const,
  scheduledDate: '2026-11-20',
  timeWindowStart: '08:00:00',
  timeWindowEnd: '12:00:00',
  customerName: 'Jane Smith',
  customerPhone: '+447700900123',
  customerEmail: 'jane@example.com',
  addressLine1: '1 High Street',
  postcode: 'LS1 1UR',
  internalNotes: 'INTERNAL: customer was rude last time',
  deliveryNotes: 'DRIVER: leave with neighbour at 3',
  accessInstructions: 'Gate code 1234',
  currentRouteId: 'f3a1c1de-0000-4000-8000-000000000002',
};

const events = [
  { toStatus: 'awaiting_scheduling' as const, createdAt: new Date('2026-11-10T09:00:00Z') },
  { toStatus: 'in_warehouse' as const, createdAt: new Date('2026-11-11T09:00:00Z') },
  { toStatus: 'scheduled' as const, createdAt: new Date('2026-11-12T09:00:00Z') },
  { toStatus: 'scheduled' as const, createdAt: new Date('2026-11-12T10:00:00Z') },
  { toStatus: 'out_for_delivery' as const, createdAt: new Date('2026-11-20T07:30:00Z') },
];

describe('toPublicTracking', () => {
  const result = toPublicTracking(fullOrder, events);

  it('exposes only customer-safe fields (TRK-03/04)', () => {
    expect(Object.keys(result).sort()).toEqual(['deliveryDate', 'status', 'statusLabel', 'timeWindow', 'timeline', 'trackingRef']);
    const json = JSON.stringify(result);
    for (const secret of [
      fullOrder.internalNotes,
      fullOrder.deliveryNotes,
      fullOrder.accessInstructions,
      fullOrder.customerPhone,
      fullOrder.customerEmail,
      fullOrder.customerName,
      fullOrder.addressLine1,
      fullOrder.id,
      fullOrder.currentRouteId,
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('builds the customer timeline without internal steps or repeats', () => {
    expect(result.timeline.map((t) => t.status)).toEqual(['awaiting_scheduling', 'scheduled', 'out_for_delivery']);
    expect(result.timeline[0]?.label).toBe('Order received');
  });

  it('formats the agreed window and date', () => {
    expect(result.timeWindow).toEqual({ from: '08:00', to: '12:00' });
    expect(result.deliveryDate).toBe('2026-11-20');
    expect(result.statusLabel).toBe('Out for delivery');
  });

  it('hides the date while the order is not booked onto a day', () => {
    expect(toPublicTracking({ ...fullOrder, status: 'returned_to_warehouse' }, []).deliveryDate).toBeNull();
  });
});
