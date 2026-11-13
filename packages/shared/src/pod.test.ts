import { describe, expect, it } from 'vitest';
import { stopDeliveredSchema } from './schemas';

const valid = {
  outcome: 'delivered',
  recipientName: '  Jane ',
  leftAtType: 'customer',
  photos: [{ path: 'orders/a/b/c.jpg' }],
  clientActionId: '6f1c8d2e-4b8a-4f43-9a51-2f0c9b7c1e11',
};

describe('stopDeliveredSchema (DRP-05)', () => {
  it('accepts a delivery handed to the customer and trims the name', () => {
    const parsed = stopDeliveredSchema.parse({ ...valid, leftAtNote: '' });
    expect(parsed.recipientName).toBe('Jane');
    expect(parsed.leftAtNote).toBeNull();
  });

  it('requires at least one photo', () => {
    const r = stopDeliveredSchema.safeParse({ ...valid, photos: [] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Take at least one photo');
  });

  it('requires a recipient name', () => {
    expect(stopDeliveredSchema.safeParse({ ...valid, recipientName: '  ' }).success).toBe(false);
  });

  it('needs a door number for a neighbour and a description for a safe place', () => {
    expect(stopDeliveredSchema.safeParse({ ...valid, leftAtType: 'neighbour' }).success).toBe(false);
    expect(stopDeliveredSchema.safeParse({ ...valid, leftAtType: 'neighbour', leftAtNote: 'No. 12' }).success).toBe(true);
    expect(stopDeliveredSchema.safeParse({ ...valid, leftAtType: 'safe_place', leftAtNote: ' ' }).success).toBe(false);
  });

  it('rejects other outcomes for now', () => {
    expect(stopDeliveredSchema.safeParse({ ...valid, outcome: 'failed' }).success).toBe(false);
  });
});
