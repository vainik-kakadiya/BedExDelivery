import { describe, expect, it } from 'vitest';
import { csvCell, toCsv, toPdf, toXlsx } from './tabular';

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formulas (CSV injection)', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3+cmd|calc')).toBe("'-2+3+cmd|calc");
  });

  it('leaves phone numbers and negative numbers alone', () => {
    expect(csvCell('+447700900123')).toBe('+447700900123');
    expect(csvCell('-12')).toBe('-12');
    expect(csvCell(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

const table = {
  filename: 'test',
  title: 'Test export',
  subtitle: '2 rows',
  columns: [
    { header: 'Name', value: (r: { name: string; qty: number }) => r.name },
    { header: 'Qty', value: (r: { name: string; qty: number }) => r.qty },
  ],
  rows: [
    { name: 'King bed – oak', qty: 1 },
    { name: 'Mattress, memory foam', qty: 2 },
  ],
};

describe('toCsv', () => {
  it('writes a UTF-8 BOM, a header and CRLF rows', () => {
    expect(toCsv(table)).toBe('﻿Name,Qty\r\nKing bed – oak,1\r\n"Mattress, memory foam",2\r\n');
  });
});

describe('binary formats', () => {
  it('produces a valid XLSX (zip) file', async () => {
    const buf = await toXlsx(table);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });

  it('produces a valid PDF, including with many rows', async () => {
    const many = { ...table, rows: Array.from({ length: 300 }, (_, i) => ({ name: `Item ${i}`, qty: i })) };
    const buf = await toPdf(many);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // 300 rows can't fit on one A4 page.
    expect((buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
