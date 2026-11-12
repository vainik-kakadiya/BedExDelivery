import type { ExportFormat } from '@bedex/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';

export type Cell = string | number | null | undefined;

export interface Column<T> {
  header: string;
  value: (row: T) => Cell;
  /** Relative width (used for XLSX character widths and PDF proportions). */
  width?: number;
}

export interface TableExport<T> {
  /** Base file name without extension. */
  filename: string;
  title: string;
  subtitle?: string;
  columns: Column<T>[];
  rows: T[];
  landscape?: boolean;
}

// ---------- CSV ----------

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER_OR_PHONE = /^[+-]?[\d\s().]+$/;

/**
 * Escape a CSV cell. Cells that would be read as a spreadsheet formula
 * ("=HYPERLINK(...)", "@SUM(...)") are prefixed with ' (CSV injection guard);
 * phone numbers like +447700900123 are left alone.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER_OR_PHONE.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(table: Pick<TableExport<T>, 'columns' | 'rows'>): string {
  const lines = [table.columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => csvCell(c.value(row))).join(','));
  // BOM so Excel opens UTF-8 (e.g. "£", "é") correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---------- XLSX ----------

export async function toXlsx<T>(table: TableExport<T>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BedEx Delivery Portal';
  const sheet = workbook.addWorksheet(table.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  sheet.columns = table.columns.map((c) => ({ header: c.header, width: Math.max(8, (c.width ?? 1) * 14) }));
  for (const row of table.rows) sheet.addRow(table.columns.map((c) => c.value(row) ?? null));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (table.rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------- PDF ----------

export function toPdf<T>(table: TableExport<T>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: table.landscape ? 'landscape' : 'portrait',
      margin: 32,
      info: { Title: table.title, Creator: 'BedEx Delivery Portal' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const totalWeight = table.columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
    const widths = table.columns.map((c) => ((c.width ?? 1) / totalWeight) * usable);
    const pad = 3;
    const fontSize = 7.5;

    const rowHeight = (cells: string[], font: string) => {
      doc.font(font).fontSize(fontSize);
      return Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: (widths[i] ?? 0) - pad * 2 }))) + pad * 2;
    };

    const drawRow = (cells: string[], font: string, fill?: string) => {
      const h = rowHeight(cells, font);
      const y = doc.y;
      if (fill) doc.rect(left, y, usable, h).fill(fill);
      doc.fillColor('#111827').font(font).fontSize(fontSize);
      let x = left;
      cells.forEach((text, i) => {
        const w = widths[i] ?? 0;
        doc.text(text, x + pad, y + pad, { width: w - pad * 2 });
        x += w;
      });
      doc.moveTo(left, y + h).lineTo(left + usable, y + h).lineWidth(0.5).strokeColor('#E5E7EB').stroke();
      doc.x = left;
      doc.y = y + h;
    };

    const headerCells = table.columns.map((c) => c.header);
    const drawHeader = () => drawRow(headerCells, 'Helvetica-Bold', '#F1F5F9');

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text(table.title);
    if (table.subtitle) doc.font('Helvetica').fontSize(9).fillColor('#4B5563').text(table.subtitle);
    doc.moveDown(0.6);
    drawHeader();

    if (table.rows.length === 0) {
      doc.moveDown(0.5).font('Helvetica').fontSize(9).fillColor('#4B5563').text('No rows match these filters.', left);
    }
    for (const row of table.rows) {
      const cells = table.columns.map((c) => {
        const v = c.value(row);
        return v === null || v === undefined ? '' : String(v);
      });
      if (doc.y + rowHeight(cells, 'Helvetica') > bottom()) {
        doc.addPage();
        drawHeader();
      }
      drawRow(cells, 'Helvetica');
    }
    doc.end();
  });
}

// ---------- response ----------

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export async function sendTable<T>(res: Response, format: ExportFormat, table: TableExport<T>): Promise<void> {
  const body =
    format === 'csv' ? Buffer.from(toCsv(table), 'utf8') : format === 'xlsx' ? await toXlsx(table) : await toPdf(table);
  const safeName = table.filename.replace(/[^\w.-]+/g, '-');
  res
    .status(200)
    .set({
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': `attachment; filename="${safeName}.${format}"`,
      'Cache-Control': 'no-store',
    })
    .send(body);
}
