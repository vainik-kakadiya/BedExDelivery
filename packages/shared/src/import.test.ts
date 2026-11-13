import { describe, expect, it } from 'vitest';
import {
  type ImportMapping,
  buildImportCandidates,
  importPreviewSchema,
  looksLikeDuplicate,
  parseImportDate,
  parseImportTime,
  suggestImportMapping,
} from './import';

const headers = ['Order No', 'Customer', 'Phone', 'Address', 'Town', 'Post Code', 'Delivery Date', 'Product', 'Qty'];
const mapping = suggestImportMapping(headers);
const row = (over: Partial<Record<string, string>> = {}) => {
  const v = {
    order: 'SO-1',
    name: 'Jane Smith',
    phone: '7700900123',
    address: '12 High Street',
    town: 'London',
    postcode: 'nw104ab',
    date: '20/11/2026',
    product: 'King bed frame',
    qty: '1',
    ...over,
  };
  return [v.order, v.name, v.phone, v.address, v.town, v.postcode, v.date, v.product, v.qty];
};
const build = (rows: string[][], m: ImportMapping = mapping) => buildImportCandidates(rows, m, { serviceMinutes: 10 });

describe('suggestImportMapping', () => {
  it('maps common header names', () => {
    expect(mapping).toEqual({
      orderNumber: 0,
      customerName: 1,
      customerPhone: 2,
      addressLine1: 3,
      town: 4,
      postcode: 5,
      scheduledDate: 6,
      itemName: 7,
      itemQty: 8,
    });
  });

  it('prefers an exact label over a vaguer alias', () => {
    expect(suggestImportMapping(['Reference', 'Order number']).orderNumber).toBe(1);
  });
});

describe('buildImportCandidates', () => {
  it('builds a valid order and normalises values', () => {
    const [c] = build([row()]);
    expect(c?.errors).toEqual([]);
    expect(c?.input).toMatchObject({
      orderNumber: 'SO-1',
      postcode: 'NW10 4AB',
      customerPhone: '+447700900123',
      scheduledDate: '2026-11-20',
      serviceMinutes: 10,
      items: [{ name: 'King bed frame', qty: 1, units: 1 }],
    });
    expect(c?.rows).toEqual([2]);
  });

  it('groups rows with the same order number into one order with several items', () => {
    const list = build([row(), row({ product: 'Mattress', qty: '2' }), row({ order: 'SO-2' })]);
    expect(list).toHaveLength(2);
    expect(list[0]?.rows).toEqual([2, 3]);
    expect(list[0]?.input?.items.map((i) => [i.name, i.qty])).toEqual([
      ['King bed frame', 1],
      ['Mattress', 2],
    ]);
  });

  it('reports readable errors per order', () => {
    const [c] = build([row({ postcode: 'nope', date: '31/02/2026', qty: 'two' })]);
    expect(c?.input).toBeNull();
    expect(c?.errors).toEqual(
      expect.arrayContaining([
        'Delivery date: "31/02/2026" is not a date (use DD/MM/YYYY)',
        'Postcode: Enter a valid UK postcode',
        'Quantity: should be a number',
      ]),
    );
  });

  it('rejects rows of one order that disagree on the postcode', () => {
    const [c] = build([row(), row({ postcode: 'SW1A 1AA', product: 'Mattress' })]);
    expect(c?.errors[0]).toMatch(/different postcodes/);
  });

  it('flags a row with no order number and skips blank rows', () => {
    const list = build([row({ order: '' }), ['', '', '', '', '', '', '', '', '']]);
    expect(list).toHaveLength(1);
    expect(list[0]?.errors).toEqual(['Order number is missing']);
  });
});

describe('value parsing', () => {
  it('reads UK and ISO dates', () => {
    expect(parseImportDate('5/1/2027')).toBe('2027-01-05');
    expect(parseImportDate('05-01-27')).toBe('2027-01-05');
    expect(parseImportDate('2027-01-05 00:00')).toBe('2027-01-05');
    expect(parseImportDate('13/13/2027')).toBeUndefined();
  });

  it('reads times', () => {
    expect(parseImportTime('9:00')).toBe('09:00');
    expect(parseImportTime('14:30:00')).toBe('14:30');
    expect(parseImportTime('2pm')).toBe('14:00');
    expect(parseImportTime('12am')).toBe('00:00');
    expect(parseImportTime('9')).toBeUndefined();
    expect(parseImportTime('25:00')).toBeUndefined();
  });
});

describe('importPreviewSchema', () => {
  it('requires the essential columns to be mapped', () => {
    const result = importPreviewSchema.safeParse({ fileName: 'a.csv', headers, rows: [row()], mapping: { orderNumber: 0 } });
    expect(result.success).toBe(false);
  });
});

describe('looksLikeDuplicate', () => {
  const a = { postcode: 'NW10 4AB', phone: '+447700900123', customerName: 'Jane Smith', itemNames: ['King bed frame'] };
  it('matches the same phone, postcode and product', () => {
    expect(looksLikeDuplicate(a, { ...a, postcode: 'nw104ab', itemNames: ['king BED frame', 'Pillows'] })).toBe(true);
  });
  it('falls back to the name when a phone is missing', () => {
    expect(looksLikeDuplicate(a, { ...a, phone: null, customerName: 'jane smith' })).toBe(true);
  });
  it('does not match a different product or person', () => {
    expect(looksLikeDuplicate(a, { ...a, itemNames: ['Sofa'] })).toBe(false);
    expect(looksLikeDuplicate(a, { ...a, phone: '+447700900999' })).toBe(false);
  });
});
