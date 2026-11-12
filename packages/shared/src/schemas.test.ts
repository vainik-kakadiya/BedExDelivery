import { describe, expect, it } from 'vitest';
import { orderCreateSchema, orderListQuerySchema, orderStatusChangeSchema, orderUpdateSchema } from './schemas';

const validOrder = {
  orderNumber: 'SO-1001',
  customerName: 'Jane Smith',
  customerPhone: '07700 900123',
  customerEmail: 'Jane@Example.com',
  addressLine1: '1 High Street',
  town: 'Leeds',
  postcode: 'ls11ur',
  items: [{ name: 'King bed frame', qty: 1 }],
};

describe('orderCreateSchema', () => {
  it('normalises postcode, phone and email and applies defaults', () => {
    const parsed = orderCreateSchema.parse(validOrder);
    expect(parsed.postcode).toBe('LS1 1UR');
    expect(parsed.customerPhone).toBe('+447700900123');
    expect(parsed.customerEmail).toBe('jane@example.com');
    expect(parsed.serviceMinutes).toBe(10);
    expect(parsed.items[0]?.units).toBe(1);
  });

  it('rejects an invalid postcode', () => {
    expect(orderCreateSchema.safeParse({ ...validOrder, postcode: 'nope' }).success).toBe(false);
  });

  it('requires a reason when extra time is added', () => {
    const r = orderCreateSchema.safeParse({ ...validOrder, extraMinutes: 20 });
    expect(r.success).toBe(false);
    expect(orderCreateSchema.safeParse({ ...validOrder, extraMinutes: 20, extraReason: 'Assembly' }).success).toBe(true);
  });

  it('requires a valid time window', () => {
    expect(orderCreateSchema.safeParse({ ...validOrder, timeWindowStart: '12:00', timeWindowEnd: '10:00' }).success).toBe(false);
    expect(orderCreateSchema.safeParse({ ...validOrder, timeWindowStart: '12:00' }).success).toBe(false);
    expect(orderCreateSchema.safeParse({ ...validOrder, timeWindowStart: '08:00', timeWindowEnd: '12:00' }).success).toBe(true);
  });
});

describe('orderUpdateSchema', () => {
  it('leaves omitted fields undefined instead of applying defaults', () => {
    const parsed = orderUpdateSchema.parse({ customerName: 'New name' });
    expect(parsed).toEqual({ customerName: 'New name' });
  });

  it('turns empty strings into null so fields can be cleared', () => {
    expect(orderUpdateSchema.parse({ internalNotes: '' }).internalNotes).toBeNull();
  });
});

describe('orderStatusChangeSchema', () => {
  it('requires a reason to cancel', () => {
    expect(orderStatusChangeSchema.safeParse({ to: 'cancelled' }).success).toBe(false);
    expect(orderStatusChangeSchema.safeParse({ to: 'cancelled', reason: 'Customer request' }).success).toBe(true);
  });

  it('requires the new date to reschedule', () => {
    expect(orderStatusChangeSchema.safeParse({ to: 'rescheduled' }).success).toBe(false);
    expect(orderStatusChangeSchema.safeParse({ to: 'rescheduled', scheduledDate: '2026-11-20' }).success).toBe(true);
  });
});

describe('orderListQuerySchema', () => {
  it('parses comma-separated statuses and ignores empty params', () => {
    const parsed = orderListQuerySchema.parse({ status: 'failed,partially_delivered', q: '', limit: '20' });
    expect(parsed.status).toEqual(['failed', 'partially_delivered']);
    expect(parsed.q).toBeUndefined();
    expect(parsed.limit).toBe(20);
  });
});
