import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, ORDER_TRANSITIONS, checkTransition, type OrderStatus } from './status';

describe('order status machine', () => {
  it('allows every transition listed in the PRD for office users', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        expect(checkTransition(from, to, 'office'), `${from} → ${to}`).toEqual({ ok: true, reopen: false });
      }
    }
  });

  it('rejects every transition not listed in the PRD', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (ORDER_TRANSITIONS[from].includes(to)) continue;
        expect(checkTransition(from, to, 'office').ok, `${from} → ${to}`).toBe(false);
      }
    }
  });

  it('keeps "failed" distinct from "returned to warehouse"', () => {
    expect(checkTransition('out_for_delivery', 'returned_to_warehouse', 'office').ok).toBe(false);
    expect(checkTransition('failed', 'returned_to_warehouse', 'office').ok).toBe(true);
  });

  it('lets only an admin reopen final orders, and only to awaiting scheduling', () => {
    for (const final of ['delivered', 'cancelled'] as OrderStatus[]) {
      expect(checkTransition(final, 'awaiting_scheduling', 'admin')).toEqual({ ok: true, reopen: true });
      expect(checkTransition(final, 'awaiting_scheduling', 'office').ok).toBe(false);
      expect(checkTransition(final, 'scheduled', 'admin').ok).toBe(false);
    }
  });

  it('restricts drivers to on-the-road and depot check-in moves', () => {
    expect(checkTransition('scheduled', 'out_for_delivery', 'driver').ok).toBe(true);
    expect(checkTransition('out_for_delivery', 'failed', 'driver').ok).toBe(true);
    expect(checkTransition('failed', 'returned_to_warehouse', 'driver').ok).toBe(true);
    expect(checkTransition('failed', 'rescheduled', 'driver').ok).toBe(false);
    expect(checkTransition('awaiting_scheduling', 'cancelled', 'driver').ok).toBe(false);
  });

  it('rejects no-op transitions', () => {
    expect(checkTransition('scheduled', 'scheduled', 'admin').ok).toBe(false);
  });
});
