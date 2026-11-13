import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cellToString, parseCsv, readSpreadsheet } from './spreadsheet';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, line breaks and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('detects semicolon and tab separators', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('readSpreadsheet', () => {
  it('reads a UTF-8 CSV with BOM, trims cells and drops trailing blank rows and columns', async () => {
    const file = Buffer.from(String.fromCharCode(0xfeff) + 'Order No, Price ,\n SO-1 ,£5,\n,,\n', 'utf8');
    expect(await readSpreadsheet(file)).toEqual({ sheetName: null, headers: ['Order No', 'Price'], rows: [['SO-1', '£5']] });
  });

  it('reads a Windows-1252 CSV', async () => {
    const file = Buffer.from([0x50, 0x0a, 0xa3, 0x35]); // "P\n£5"
    expect((await readSpreadsheet(file)).rows).toEqual([['£5']]);
  });

  it('reads the first sheet of an XLSX file', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Orders');
    sheet.addRow(['Order No', 'Date', 'Phone']);
    sheet.addRow(['SO-1', new Date(Date.UTC(2026, 10, 20)), 7700900123]);
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await readSpreadsheet(file)).toEqual({
      sheetName: 'Orders',
      headers: ['Order No', 'Date', 'Phone'],
      rows: [['SO-1', '2026-11-20', '7700900123']],
    });
  });

  it('rejects old .xls files and empty files', async () => {
    await expect(readSpreadsheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).rejects.toThrow(/xls/);
    await expect(readSpreadsheet(Buffer.from('Order No\n'))).rejects.toThrow(/no orders/);
  });
});

describe('cellToString', () => {
  it('converts Excel times, formulas and rich text', () => {
    expect(cellToString(new Date(Date.UTC(1899, 11, 30, 9, 30)))).toBe('09:30');
    expect(cellToString({ formula: 'A1', result: 3 } as ExcelJS.CellValue)).toBe('3');
    expect(cellToString({ richText: [{ text: 'Ja' }, { text: 'ne' }] })).toBe('Jane');
  });
});
