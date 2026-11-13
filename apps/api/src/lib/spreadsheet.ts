import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS } from '@bedex/shared';
import ExcelJS from 'exceljs';
import { badRequest } from './errors';

export interface SheetTable {
  sheetName: string | null;
  headers: string[];
  rows: string[][];
}

const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // ZIP container
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // old binary Excel

const startsWith = (buf: Buffer, magic: number[]) => magic.every((b, i) => buf[i] === b);

/** Read an uploaded CSV or XLSX file into a header row and data rows of trimmed strings. */
export async function readSpreadsheet(file: Buffer): Promise<SheetTable> {
  if (file.length === 0) throw badRequest('The file is empty');
  if (startsWith(file, XLS_MAGIC)) {
    throw badRequest('Old .xls files are not supported. In Excel, use "Save as" → Excel Workbook (.xlsx) or CSV.');
  }
  const table = startsWith(file, XLSX_MAGIC) ? await readXlsx(file) : { sheetName: null, grid: parseCsv(decodeText(file)) };
  return toTable(table.sheetName, table.grid);
}

function toTable(sheetName: string | null, grid: string[][]): SheetTable {
  const cleaned = grid.map((row) => row.map((c) => c.trim()));
  const headerIndex = cleaned.findIndex((row) => row.some((c) => c !== ''));
  if (headerIndex < 0) throw badRequest('The file has no data');

  const body = cleaned.slice(headerIndex + 1);
  while (body.length && body.at(-1)!.every((c) => c === '')) body.pop();
  if (body.length === 0) throw badRequest('The file has a header row but no orders under it');
  if (body.length > IMPORT_MAX_ROWS) {
    throw badRequest(`The file has ${body.length} rows. Import at most ${IMPORT_MAX_ROWS} at a time by splitting the file.`);
  }

  const headerRow = cleaned[headerIndex]!;
  // Ignore empty columns at the right-hand edge.
  let width = Math.max(headerRow.length, ...body.map((r) => r.length));
  while (width > 0 && headerRow[width - 1] === '' && body.every((r) => (r[width - 1] ?? '') === '')) width--;
  if (width > IMPORT_MAX_COLUMNS) throw badRequest(`The file has more than ${IMPORT_MAX_COLUMNS} columns`);

  const headers = Array.from({ length: width }, (_, i) => headerRow[i] || `Column ${i + 1}`);
  const rows = body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { sheetName, headers, rows };
}

// ---------- CSV ----------

function decodeText(file: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    // Excel on Windows saves "CSV" (not "CSV UTF-8") as Windows-1252, e.g. "£".
    text = new TextDecoder('windows-1252').decode(file);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** RFC 4180 CSV with quoted fields and line breaks inside quotes. Detects , ; or tab as the separator. */
export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map((d) => ({ d, n: unquoted.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ',';
}

// ---------- XLSX ----------

async function readXlsx(file: Buffer): Promise<{ sheetName: string; grid: string[][] }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw badRequest('This Excel file could not be read. Re-save it as .xlsx or CSV and try again.');
  }
  const sheet = workbook.worksheets.find((s) => s.state !== 'hidden' && s.actualRowCount > 0);
  if (!sheet) throw badRequest('The workbook has no data');
  if (sheet.actualRowCount > IMPORT_MAX_ROWS + 1) {
    throw badRequest(`The sheet has ${sheet.actualRowCount - 1} rows. Import at most ${IMPORT_MAX_ROWS} at a time by splitting the file.`);
  }

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col <= IMPORT_MAX_COLUMNS + 1) cells[col - 1] = cellToString(cell.value);
    });
    grid[rowNumber - 1] = Array.from(cells, (c) => c ?? '');
  });
  return { sheetName: sheet.name, grid: Array.from(grid, (r) => r ?? []) };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel stores times as a fraction of a day from 1899-12-30, read here as UTC.
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
    if (value.getUTCFullYear() < 1900) return time;
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    return time === '00:00' ? date : `${date} ${time}`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('error' in value) return '';
  if ('result' in value) return cellToString((value.result ?? null) as ExcelJS.CellValue);
  if ('text' in value) return typeof value.text === 'string' ? value.text : cellToString(value.text as ExcelJS.CellValue);
  return '';
}
