import { z } from 'zod';
import { postcodeKey } from './format';
import { type OrderCreateInput, orderCreateSchema } from './schemas';

/**
 * ORD-05: order import from a spreadsheet. The API reads the file into a plain
 * table of strings; the office maps columns to these fields; the rows are then
 * turned into orders here, so the browser preview and the API agree exactly.
 *
 * Rows that share an order number become one order with several items, so a
 * bed frame and a mattress on one order can be two lines in the file.
 */

export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_COLUMNS = 100;

type FieldGroup = 'order' | 'customer' | 'delivery' | 'item';

interface ImportFieldDef {
  label: string;
  group: FieldGroup;
  required?: boolean;
  /** Header names this field is guessed from (compared without case, spaces or punctuation). */
  aliases: string[];
  example: string;
}

export const IMPORT_FIELDS = {
  orderNumber: {
    label: 'Order number',
    group: 'order',
    required: true,
    aliases: ['order no', 'order number', 'order num', 'order id', 'order ref', 'order reference', 'order', 'reference', 'ref', 'invoice', 'invoice no', 'sales order'],
    example: 'SO-10045',
  },
  scheduledDate: {
    label: 'Delivery date',
    group: 'order',
    aliases: ['delivery date', 'scheduled date', 'date', 'deliver on', 'due date'],
    example: '20/11/2026',
  },
  customerName: {
    label: 'Customer name',
    group: 'customer',
    required: true,
    aliases: ['customer name', 'customer', 'name', 'full name', 'recipient', 'contact name', 'deliver to'],
    example: 'Jane Smith',
  },
  customerPhone: {
    label: 'Phone',
    group: 'customer',
    aliases: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'mobile number', 'contact number', 'customer phone'],
    example: '07700 900123',
  },
  customerEmail: {
    label: 'Email',
    group: 'customer',
    aliases: ['email', 'email address', 'e-mail', 'customer email'],
    example: 'jane@example.com',
  },
  addressLine1: {
    label: 'Address line 1',
    group: 'customer',
    required: true,
    aliases: ['address line 1', 'address 1', 'address1', 'address', 'street', 'street address', 'line 1'],
    example: '12 High Street',
  },
  addressLine2: {
    label: 'Address line 2',
    group: 'customer',
    aliases: ['address line 2', 'address 2', 'address2', 'line 2', 'flat', 'locality'],
    example: 'Flat 3',
  },
  town: {
    label: 'Town / city',
    group: 'customer',
    required: true,
    aliases: ['town', 'city', 'town city', 'town/city', 'post town'],
    example: 'London',
  },
  postcode: {
    label: 'Postcode',
    group: 'customer',
    required: true,
    aliases: ['postcode', 'post code', 'postal code', 'zip', 'zip code'],
    example: 'NW10 4AB',
  },
  timeWindowStart: {
    label: 'Time window start',
    group: 'delivery',
    aliases: ['time window start', 'window start', 'from', 'time from', 'start time', 'earliest'],
    example: '09:00',
  },
  timeWindowEnd: {
    label: 'Time window end',
    group: 'delivery',
    aliases: ['time window end', 'window end', 'to', 'time to', 'end time', 'latest'],
    example: '12:00',
  },
  serviceMinutes: {
    label: 'Service time (minutes)',
    group: 'delivery',
    aliases: ['service minutes', 'service time', 'minutes on site', 'stop time'],
    example: '15',
  },
  requiresSignature: {
    label: 'Signature required',
    group: 'delivery',
    aliases: ['requires signature', 'signature required', 'signature'],
    example: 'Yes',
  },
  accessInstructions: {
    label: 'Access instructions',
    group: 'delivery',
    aliases: ['access instructions', 'access', 'access notes', 'parking'],
    example: 'Side gate, code 1234',
  },
  deliveryNotes: {
    label: 'Delivery notes',
    group: 'delivery',
    aliases: ['delivery notes', 'notes', 'delivery instructions', 'instructions', 'comments'],
    example: 'Call 30 min before',
  },
  internalNotes: {
    label: 'Internal notes (office only)',
    group: 'delivery',
    aliases: ['internal notes', 'office notes', 'private notes'],
    example: '',
  },
  itemName: {
    label: 'Item / product',
    group: 'item',
    required: true,
    aliases: ['item', 'item name', 'product', 'product name', 'description', 'item description', 'goods'],
    example: 'King size bed frame',
  },
  itemQty: {
    label: 'Quantity',
    group: 'item',
    aliases: ['qty', 'quantity', 'item qty', 'count', 'pieces'],
    example: '1',
  },
  itemSku: {
    label: 'SKU',
    group: 'item',
    aliases: ['sku', 'item sku', 'product code', 'item code', 'code'],
    example: 'BF-KING-OAK',
  },
  itemUnits: {
    label: 'Load units per item',
    group: 'item',
    aliases: ['units', 'load units', 'item units'],
    example: '2',
  },
  itemWeightKg: {
    label: 'Weight (kg)',
    group: 'item',
    aliases: ['weight', 'weight kg', 'kg', 'item weight'],
    example: '45',
  },
  itemVolumeM3: {
    label: 'Volume (m³)',
    group: 'item',
    aliases: ['volume', 'volume m3', 'm3', 'cubic metres', 'item volume'],
    example: '0.8',
  },
} satisfies Record<string, ImportFieldDef>;

export type ImportField = keyof typeof IMPORT_FIELDS;
export const IMPORT_FIELD_KEYS = Object.keys(IMPORT_FIELDS) as [ImportField, ...ImportField[]];
export const IMPORT_FIELD_GROUPS: { group: FieldGroup; label: string }[] = [
  { group: 'order', label: 'Order' },
  { group: 'customer', label: 'Customer & address' },
  { group: 'delivery', label: 'Delivery' },
  { group: 'item', label: 'Items (one per row)' },
];
export const REQUIRED_IMPORT_FIELDS = IMPORT_FIELD_KEYS.filter((k) => (IMPORT_FIELDS[k] as ImportFieldDef).required);

/** Field → zero-based column index in the file. */
export type ImportMapping = Partial<Record<ImportField, number>>;

const headerKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Guess the mapping from the file's header names. Each column is used at most once. */
export function suggestImportMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  const used = new Set<number>();
  const keys = headers.map(headerKey);
  // Two passes: exact label/key matches first, so "Order number" isn't taken by the vaguer "order" alias.
  for (const strict of [true, false]) {
    for (const field of IMPORT_FIELD_KEYS) {
      if (mapping[field] !== undefined) continue;
      const def = IMPORT_FIELDS[field] as ImportFieldDef;
      const names = (strict ? [def.label, field] : def.aliases).map(headerKey);
      const col = keys.findIndex((k, i) => !used.has(i) && k !== '' && names.includes(k));
      if (col >= 0) {
        mapping[field] = col;
        used.add(col);
      }
    }
  }
  return mapping;
}

// ---------- requests & responses ----------

const tableShape = {
  fileName: z.string().trim().min(1).max(255),
  headers: z.array(z.string().max(500)).min(1).max(IMPORT_MAX_COLUMNS),
  rows: z
    .array(z.array(z.string().max(5000)).max(IMPORT_MAX_COLUMNS))
    .min(1, 'The file has no data rows')
    .max(IMPORT_MAX_ROWS, `Import at most ${IMPORT_MAX_ROWS} rows at a time`),
  mapping: z.record(z.enum(IMPORT_FIELD_KEYS), z.number().int().min(0).max(IMPORT_MAX_COLUMNS - 1)),
};

const checkMapping = (v: { headers: string[]; mapping: ImportMapping }, ctx: z.RefinementCtx) => {
  for (const field of REQUIRED_IMPORT_FIELDS) {
    if (v.mapping[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mapping', field], message: `Choose the column for "${IMPORT_FIELDS[field].label}"` });
    }
  }
  for (const [field, col] of Object.entries(v.mapping)) {
    if (col !== undefined && col >= v.headers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mapping', field], message: 'That column is not in the file' });
    }
  }
};

export const importPreviewSchema = z.object(tableShape).superRefine(checkMapping);
export type ImportPreviewInput = z.infer<typeof importPreviewSchema>;

export const importCommitSchema = z
  .object({ ...tableShape, includePossibleDuplicates: z.boolean().default(false) })
  .superRefine(checkMapping);
export type ImportCommitInput = z.infer<typeof importCommitSchema>;

/** What the API read from an uploaded file. */
export interface ImportParseResult {
  fileName: string;
  sheetName: string | null;
  headers: string[];
  rows: string[][];
  suggestedMapping: ImportMapping;
}

/**
 * ready: will be imported. duplicate: looks like a recent order (ORD-06), skipped unless chosen.
 * exists: the order number is already in the system. error: fix the file and re-import.
 */
export type ImportOrderStatus = 'ready' | 'duplicate' | 'exists' | 'error';

export interface ImportPreviewOrder {
  /** Spreadsheet row numbers (the header is row 1). */
  rows: number[];
  orderNumber: string;
  customerName: string;
  postcode: string;
  town: string;
  scheduledDate: string | null;
  itemCount: number;
  status: ImportOrderStatus;
  messages: string[];
}

export interface ImportPreview {
  orders: ImportPreviewOrder[];
  counts: Record<ImportOrderStatus, number>;
  duplicateWindowDays: number;
}

export interface ImportCommitResult {
  jobId: string;
  imported: number;
  skippedExisting: number;
  skippedDuplicates: number;
  failed: number;
}

// ---------- rows → orders ----------

export interface ImportCandidate {
  rows: number[];
  orderNumber: string;
  /** Present when the rows make a valid order. */
  input: OrderCreateInput | null;
  errors: string[];
  /** Raw display values, so invalid orders can still be shown. */
  customerName: string;
  postcode: string;
  town: string;
}

export interface ImportDefaults {
  serviceMinutes: number;
}

/** Turn mapped spreadsheet rows into orders, validating each against the same rules as manual entry. */
export function buildImportCandidates(
  rows: string[][],
  mapping: ImportMapping,
  defaults: ImportDefaults,
): ImportCandidate[] {
  const groups = new Map<string, { rows: number[]; cells: ((f: ImportField) => string)[] }>();
  const loose: ImportCandidate[] = [];

  rows.forEach((row, index) => {
    if (row.every((c) => c.trim() === '')) return;
    const rowNumber = index + 2;
    const cell = (f: ImportField) => {
      const col = mapping[f];
      return col === undefined ? '' : (row[col] ?? '').trim();
    };
    const orderNumber = cell('orderNumber');
    if (!orderNumber) {
      loose.push({
        rows: [rowNumber],
        orderNumber: '',
        input: null,
        errors: ['Order number is missing'],
        customerName: cell('customerName'),
        postcode: cell('postcode'),
        town: cell('town'),
      });
      return;
    }
    const group = groups.get(orderNumber) ?? { rows: [], cells: [] };
    group.rows.push(rowNumber);
    group.cells.push(cell);
    groups.set(orderNumber, group);
  });

  const candidates = [...groups.entries()].map(([orderNumber, g]) => buildCandidate(orderNumber, g.rows, g.cells, defaults));
  return [...candidates, ...loose].sort((a, b) => (a.rows[0] ?? 0) - (b.rows[0] ?? 0));
}

function buildCandidate(
  orderNumber: string,
  rowNumbers: number[],
  cells: ((f: ImportField) => string)[],
  defaults: ImportDefaults,
): ImportCandidate {
  const first = cells[0]!;
  const errors: string[] = [];
  const base = { rows: rowNumbers, orderNumber, customerName: first('customerName'), postcode: first('postcode'), town: first('town') };

  // Rows of one order must agree on where it goes.
  const postcodes = new Set(cells.map((c) => postcodeKey(c('postcode'))).filter(Boolean));
  if (postcodes.size > 1) errors.push(`Rows ${rowNumbers.join(', ')} share this order number but have different postcodes`);

  const convert = <T>(field: ImportField, raw: string, parse: (v: string) => T | undefined, hint: string): T | null => {
    if (!raw) return null;
    const value = parse(raw);
    if (value === undefined) {
      errors.push(`${IMPORT_FIELDS[field].label}: "${raw}" ${hint}`);
      return null;
    }
    return value;
  };

  const items = cells
    .map((c, i) => ({ c, row: rowNumbers[i]! }))
    .filter(({ c }) => c('itemName') || c('itemSku') || c('itemQty'))
    .map(({ c }) => ({
      name: c('itemName'),
      sku: c('itemSku') || null,
      qty: c('itemQty') ? parseNumber(c('itemQty')) ?? c('itemQty') : 1,
      units: c('itemUnits') ? parseNumber(c('itemUnits')) ?? c('itemUnits') : 1,
      weightKg: c('itemWeightKg') ? parseNumber(c('itemWeightKg')) ?? c('itemWeightKg') : null,
      volumeM3: c('itemVolumeM3') ? parseNumber(c('itemVolumeM3')) ?? c('itemVolumeM3') : null,
    }));

  const draft = {
    orderNumber,
    customerName: first('customerName'),
    customerPhone: fixSpreadsheetPhone(first('customerPhone')) || null,
    customerEmail: first('customerEmail') || null,
    addressLine1: first('addressLine1'),
    addressLine2: first('addressLine2') || null,
    town: first('town'),
    postcode: first('postcode'),
    scheduledDate: convert('scheduledDate', first('scheduledDate'), parseImportDate, 'is not a date (use DD/MM/YYYY)'),
    timeWindowStart: convert('timeWindowStart', first('timeWindowStart'), parseImportTime, 'is not a time (use HH:MM)'),
    timeWindowEnd: convert('timeWindowEnd', first('timeWindowEnd'), parseImportTime, 'is not a time (use HH:MM)'),
    serviceMinutes: first('serviceMinutes') ? parseNumber(first('serviceMinutes')) ?? first('serviceMinutes') : defaults.serviceMinutes,
    requiresSignature: convert('requiresSignature', first('requiresSignature'), parseYesNo, 'should be Yes or No') ?? false,
    accessInstructions: first('accessInstructions') || null,
    deliveryNotes: first('deliveryNotes') || null,
    internalNotes: first('internalNotes') || null,
    items,
  };

  const parsed = orderCreateSchema.safeParse(draft);
  if (!parsed.success) errors.push(...describeIssues(parsed.error, rowNumbers, items.length));
  if (errors.length || !parsed.success) return { ...base, input: null, errors: [...new Set(errors)] };
  return { ...base, input: parsed.data, errors: [] };
}

const FIELD_FOR_PATH: Record<string, ImportField> = {
  orderNumber: 'orderNumber',
  customerName: 'customerName',
  customerPhone: 'customerPhone',
  customerEmail: 'customerEmail',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  town: 'town',
  postcode: 'postcode',
  scheduledDate: 'scheduledDate',
  timeWindowStart: 'timeWindowStart',
  timeWindowEnd: 'timeWindowEnd',
  serviceMinutes: 'serviceMinutes',
  accessInstructions: 'accessInstructions',
  deliveryNotes: 'deliveryNotes',
  internalNotes: 'internalNotes',
};
const ITEM_FIELD_FOR_PATH: Record<string, ImportField> = {
  name: 'itemName',
  sku: 'itemSku',
  qty: 'itemQty',
  units: 'itemUnits',
  weightKg: 'itemWeightKg',
  volumeM3: 'itemVolumeM3',
};

function describeIssues(error: z.ZodError, rowNumbers: number[], itemCount: number): string[] {
  return error.issues.map((issue) => {
    const [head, index, sub] = issue.path;
    if (head === 'items') {
      if (index === undefined || itemCount === 0) return 'No item: give each row an item / product name';
      const field = ITEM_FIELD_FOR_PATH[String(sub)];
      const label = field ? IMPORT_FIELDS[field].label : 'Item';
      const where = rowNumbers.length > 1 ? ` (row ${rowNumbers[Number(index)] ?? '?'})` : '';
      return `${label}${where}: ${friendlyMessage(issue)}`;
    }
    const field = FIELD_FOR_PATH[String(head)];
    return `${field ? IMPORT_FIELDS[field].label : String(head)}: ${friendlyMessage(issue)}`;
  });
}

function friendlyMessage(issue: z.ZodIssue): string {
  if (issue.code === 'too_small' && issue.type === 'string') return 'is missing';
  if (issue.code === 'invalid_type' && issue.received === 'nan') return 'should be a number';
  if (issue.code === 'invalid_type' && issue.received === 'undefined') return 'is missing';
  if (issue.code === 'invalid_string' && issue.validation === 'email') return 'is not a valid email address';
  return issue.message;
}

// ---------- value parsing ----------

function parseNumber(raw: string): number | undefined {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Accepts 2026-11-20 and UK day-first dates: 20/11/2026, 20-11-26, 20.11.2026. */
export function parseImportDate(raw: string): string | undefined {
  const v = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (uk) [d, m, y] = [Number(uk[1]), Number(uk[2]), Number(uk[3]!.length === 2 ? `20${uk[3]}` : uk[3])];
  else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Accepts 9:00, 09:00:00, 9.30, 9am, 2:30pm. */
export function parseImportTime(raw: string): string | undefined {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm)?$/i.exec(raw.trim());
  if (!match || (match[2] === undefined && !match[3])) return undefined;
  let h = Number(match[1]);
  const min = Number(match[2] ?? 0);
  const suffix = match[3]?.toLowerCase();
  if (suffix) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (suffix === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseYesNo(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'x'].includes(v)) return true;
  if (['no', 'n', 'false', '0', '-'].includes(v)) return false;
  return undefined;
}

/** Spreadsheets drop the leading 0 from numbers stored as numbers: 7700900123 → 07700900123. */
function fixSpreadsheetPhone(raw: string): string {
  return /^[1-9]\d{9}$/.test(raw) ? `0${raw}` : raw;
}

// ---------- duplicates (ORD-06) ----------

export interface DuplicateProbe {
  postcode: string;
  phone: string | null;
  customerName: string;
  itemNames: string[];
}

/**
 * Same postcode, same phone (or the same name when either has no phone),
 * and at least one product in common.
 */
export function looksLikeDuplicate(a: DuplicateProbe, b: DuplicateProbe): boolean {
  if (postcodeKey(a.postcode) !== postcodeKey(b.postcode)) return false;
  const samePerson =
    a.phone && b.phone ? a.phone === b.phone : a.customerName.trim().toLowerCase() === b.customerName.trim().toLowerCase();
  if (!samePerson) return false;
  const names = new Set(a.itemNames.map((n) => n.trim().toLowerCase()));
  return b.itemNames.some((n) => names.has(n.trim().toLowerCase()));
}
