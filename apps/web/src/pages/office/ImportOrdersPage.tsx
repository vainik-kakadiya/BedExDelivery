import {
  IMPORT_FIELDS,
  IMPORT_FIELD_GROUPS,
  IMPORT_FIELD_KEYS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  type ImportCommitResult,
  type ImportField,
  type ImportMapping,
  type ImportOrderStatus,
  type ImportParseResult,
  type ImportPreview,
  REQUIRED_IMPORT_FIELDS,
  formatUkDate,
} from '@bedex/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { type DragEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, request } from '../../lib/api';
import { cn } from '../../lib/cn';

type Step = 'upload' | 'map' | 'review' | 'done';

const STEPS: { key: Exclude<Step, 'done'>; label: string }[] = [
  { key: 'upload', label: 'Upload file' },
  { key: 'map', label: 'Match columns' },
  { key: 'review', label: 'Review & import' },
];

const STATUS_STYLE: Record<ImportOrderStatus, { label: string; badge: string; card: string }> = {
  ready: { label: 'Ready', badge: 'bg-success/10 text-success', card: 'border-success/30' },
  duplicate: { label: 'Possible duplicate', badge: 'bg-warning/10 text-warning', card: 'border-warning/30' },
  exists: { label: 'Already exists', badge: 'bg-slate-100 text-slate-600', card: 'border-slate-300' },
  error: { label: 'Needs fixing', badge: 'bg-danger/10 text-danger', card: 'border-danger/30' },
};

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

// ---------- remembered mapping ----------

/** The last mapping, by header name, so a repeat import from the same system needs no re-matching. */
const MAPPING_KEY = 'bedex.importMapping';

function loadMapping(headers: string[], suggested: ImportMapping): ImportMapping {
  const mapping: ImportMapping = { ...suggested };
  try {
    const saved = JSON.parse(localStorage.getItem(MAPPING_KEY) ?? '{}') as Record<string, string>;
    for (const field of IMPORT_FIELD_KEYS) {
      const col = saved[field] ? headers.indexOf(saved[field]) : -1;
      if (col >= 0) mapping[field] = col;
    }
  } catch {
    // No saved mapping, or storage is unavailable.
  }
  return mapping;
}

function saveMapping(headers: string[], mapping: ImportMapping) {
  try {
    const byName = Object.fromEntries(Object.entries(mapping).map(([field, col]) => [field, headers[col]]));
    localStorage.setItem(MAPPING_KEY, JSON.stringify(byName));
  } catch {
    // Remembering is a convenience only.
  }
}

// ---------- template ----------

/** Lets Excel open the UTF-8 CSV correctly. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function downloadTemplate() {
  const fields = IMPORT_FIELD_KEYS;
  const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const example = fields.map((f) => IMPORT_FIELDS[f].example);
  // A second row with the same order number adds another item to that order.
  const secondItem = fields.map((f) =>
    f === 'itemName' ? 'King size mattress' : f === 'itemSku' ? 'MT-KING' : f === 'itemUnits' ? '1' : f === 'itemWeightKg' ? '30' : f === 'itemVolumeM3' ? '0.6' : IMPORT_FIELDS[f].example,
  );
  const lines = [fields.map((f) => IMPORT_FIELDS[f].label), example, secondItem].map((r) => r.map(csv).join(','));
  const url = URL.createObjectURL(new Blob([`${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bedex-order-import-template.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- page ----------

/** ORD-05/06: import orders from a CSV or Excel file. */
export function ImportOrdersPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('upload');
  const [table, setTable] = useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const parse = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > IMPORT_MAX_FILE_BYTES) throw new ApiError(413, 'TOO_LARGE', 'That file is over 5 MB. Split it into smaller files.');
      const res = await request(`/orders/import/parse?fileName=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      return (await res.json()) as ImportParseResult;
    },
    onSuccess: (parsed) => {
      setTable(parsed);
      setMapping(loadMapping(parsed.headers, parsed.suggestedMapping));
      setPreview(null);
      setStep('map');
    },
  });

  const body = () => ({ fileName: table!.fileName, headers: table!.headers, rows: table!.rows, mapping });

  const check = useMutation({
    mutationFn: () => api<ImportPreview>('/orders/import/preview', { method: 'POST', json: body() }),
    onSuccess: (p) => {
      saveMapping(table!.headers, mapping);
      setPreview(p);
      setIncludeDuplicates(false);
      setStep('review');
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api<ImportCommitResult>('/orders/import/commit', { method: 'POST', json: { ...body(), includePossibleDuplicates: includeDuplicates } }),
    onSuccess: (r) => {
      setResult(r);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const restart = () => {
    setStep('upload');
    setTable(null);
    setPreview(null);
    setResult(null);
    parse.reset();
    check.reset();
    commit.reset();
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/office/orders" className="mb-1 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Orders
          </Link>
          <h1 className="text-xl font-semibold">Import orders</h1>
        </div>
        {step !== 'done' && <StepIndicator current={step} />}
      </div>

      {step === 'upload' && <UploadStep onFile={(f) => parse.mutate(f)} busy={parse.isPending} error={parse.isError ? errorText(parse.error, 'Could not read that file.') : null} />}

      {step === 'map' && table && (
        <MapStep
          table={table}
          mapping={mapping}
          onChange={setMapping}
          onBack={restart}
          onNext={() => check.mutate()}
          busy={check.isPending}
          error={check.isError ? errorText(check.error, 'Could not check the orders. Try again.') : null}
        />
      )}

      {step === 'review' && preview && table && (
        <ReviewStep
          preview={preview}
          includeDuplicates={includeDuplicates}
          onIncludeDuplicates={setIncludeDuplicates}
          onBack={() => setStep('map')}
          onImport={() => commit.mutate()}
          busy={commit.isPending}
          error={commit.isError ? errorText(commit.error, 'The import failed. Nothing was saved; try again.') : null}
        />
      )}

      {step === 'done' && result && <DoneStep result={result} onAgain={restart} />}
    </div>
  );
}

function StepIndicator({ current }: { current: Exclude<Step, 'done'> }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 text-sm">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-4 bg-border sm:w-8" aria-hidden />}
          <span
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
              i <= index ? 'bg-brand-primary text-white' : 'bg-slate-200 text-slate-500',
            )}
          >
            {i + 1}
          </span>
          <span className={cn('hidden sm:inline', i === index ? 'font-medium text-ink' : 'text-slate-500')} aria-current={i === index ? 'step' : undefined}>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------- step 1 ----------

function UploadStep({ onFile, busy, error }: { onFile: (f: File) => void; busy: boolean; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && !busy) onFile(file);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="card p-6 lg:col-span-2">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors',
            dragging ? 'border-brand-primary bg-brand-primary/5' : 'border-border hover:border-brand-primary/50 hover:bg-surface',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          <FileSpreadsheet className="h-10 w-10 text-brand-primary" aria-hidden />
          <span className="text-base font-medium">{busy ? 'Reading file…' : 'Drop a CSV or Excel file here'}</span>
          <span className="text-sm text-slate-500">or click to choose one · .csv or .xlsx · up to 5 MB and {IMPORT_MAX_ROWS.toLocaleString()} rows</span>
          <input
            ref={input}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = '';
            }}
          />
        </label>
        {error && (
          <p role="alert" className="mt-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="card space-y-3 p-6 text-sm text-slate-600">
        <h2 className="text-base font-semibold text-ink">How it works</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>One row per item. Rows with the same order number become one order, e.g. a bed frame and a mattress.</li>
          <li>Required: order number, customer name, address line 1, town, postcode and item.</li>
          <li>Dates as DD/MM/YYYY, times as HH:MM.</li>
          <li>Nothing is saved until you review the orders and click Import.</li>
          <li>Orders already in the system are skipped, so you can safely re-import a corrected file.</li>
        </ul>
        <button type="button" onClick={downloadTemplate} className="btn-secondary w-full">
          <Download className="h-4 w-4" aria-hidden />
          Download template
        </button>
      </div>
    </div>
  );
}

// ---------- step 2 ----------

interface MapStepProps {
  table: ImportParseResult;
  mapping: ImportMapping;
  onChange: (m: ImportMapping) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  error: string | null;
}

function MapStep({ table, mapping, onChange, onBack, onNext, busy, error }: MapStepProps) {
  const missing = REQUIRED_IMPORT_FIELDS.filter((f) => mapping[f] === undefined);
  const sample = (col: number | undefined) => {
    if (col === undefined) return '';
    return table.rows.slice(0, 20).find((r) => r[col])?.[col] ?? '';
  };
  const setField = (field: ImportField, value: string) => {
    const next = { ...mapping };
    if (value === '') delete next[field];
    else next[field] = Number(value);
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <FileSpreadsheet className="h-8 w-8 shrink-0 text-brand-primary" aria-hidden />
          <div>
            <p className="font-medium">{table.fileName}</p>
            <p className="text-sm text-slate-500">
              {table.sheetName && `Sheet "${table.sheetName}" · `}
              {table.rows.length.toLocaleString()} rows · {table.headers.length} columns
            </p>
          </div>
        </div>
        <button type="button" onClick={onBack} className="btn-secondary">
          Choose a different file
        </button>
      </div>

      <p className="text-sm text-slate-600">
        Match each field to a column in your file. We have guessed where we can; fields marked <span className="text-danger">*</span> are
        required.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {IMPORT_FIELD_GROUPS.map(({ group, label }) => (
          <fieldset key={group} className="card p-4">
            <legend className="sr-only">{label}</legend>
            <h2 className="mb-3 font-semibold">{label}</h2>
            <div className="space-y-2">
              {IMPORT_FIELD_KEYS.filter((f) => IMPORT_FIELDS[f].group === group).map((field) => {
                const def = IMPORT_FIELDS[field];
                const required = REQUIRED_IMPORT_FIELDS.includes(field);
                const col = mapping[field];
                const example = sample(col);
                return (
                  <div key={field} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                    <label htmlFor={`map-${field}`} className="text-sm font-medium">
                      {def.label}
                      {required && <span className="text-danger"> *</span>}
                    </label>
                    <div className="min-w-0">
                      <select
                        id={`map-${field}`}
                        value={col ?? ''}
                        onChange={(e) => setField(field, e.target.value)}
                        className={cn('input py-1.5', required && col === undefined && 'border-danger/60')}
                      >
                        <option value="">— Not in file —</option>
                        {table.headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h}
                          </option>
                        ))}
                      </select>
                      {example && (
                        <p className="mt-0.5 truncate text-xs text-slate-500" title={example}>
                          e.g. {example}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {missing.length > 0 && (
          <p className="text-sm text-slate-500">Still to match: {missing.map((f) => IMPORT_FIELDS[f].label).join(', ')}</p>
        )}
        <button type="button" onClick={onNext} disabled={missing.length > 0 || busy} className="btn-primary min-h-tap">
          {busy ? 'Checking orders…' : 'Check orders'}
        </button>
      </div>
    </div>
  );
}

// ---------- step 3 ----------

interface ReviewStepProps {
  preview: ImportPreview;
  includeDuplicates: boolean;
  onIncludeDuplicates: (v: boolean) => void;
  onBack: () => void;
  onImport: () => void;
  busy: boolean;
  error: string | null;
}

function ReviewStep({ preview, includeDuplicates, onIncludeDuplicates, onBack, onImport, busy, error }: ReviewStepProps) {
  const { counts } = preview;
  const [filter, setFilter] = useState<ImportOrderStatus | 'all'>(() =>
    counts.error > 0 ? 'error' : counts.duplicate > 0 ? 'duplicate' : 'all',
  );
  const toImport = counts.ready + (includeDuplicates ? counts.duplicate : 0);
  const shown = filter === 'all' ? preview.orders : preview.orders.filter((o) => o.status === filter);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(Object.keys(STATUS_STYLE) as ImportOrderStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(filter === s ? 'all' : s)}
            aria-pressed={filter === s}
            className={cn('card border-l-4 p-3 text-left transition-shadow hover:shadow-md', STATUS_STYLE[s].card, filter === s && 'ring-2 ring-brand-primary')}
          >
            <span className="block text-2xl font-semibold">{counts[s]}</span>
            <span className="text-sm text-slate-600">{STATUS_STYLE[s].label}</span>
          </button>
        ))}
      </div>

      {(counts.error > 0 || counts.exists > 0) && (
        <p className="text-sm text-slate-600">
          Orders that need fixing or already exist are skipped. Fix them in your file and import it again; orders imported this time will
          then show as already existing.
        </p>
      )}

      <div className="card max-h-[55vh] overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(var(--border))]">
            <tr>
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">Order</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Postcode</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Items</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((o) => (
              <tr key={`${o.rows[0]}-${o.orderNumber}`} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{o.rows.length > 1 ? `${o.rows[0]}–${o.rows.at(-1)}` : o.rows[0]}</td>
                <td className="px-3 py-2 font-medium">{o.orderNumber || '–'}</td>
                <td className="px-3 py-2">
                  {o.customerName || '–'}
                  {o.town && <span className="block text-xs text-slate-500">{o.town}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{o.postcode || '–'}</td>
                <td className="whitespace-nowrap px-3 py-2">{o.scheduledDate ? formatUkDate(o.scheduledDate) : '–'}</td>
                <td className="px-3 py-2">{o.itemCount || '–'}</td>
                <td className="px-3 py-2">
                  <span className={cn('inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[o.status].badge)}>
                    {STATUS_STYLE[o.status].label}
                  </span>
                  {o.messages.map((m) => (
                    <span key={m} className="mt-1 block text-xs text-slate-600">
                      {m}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="p-6 text-center text-slate-500">No orders in this group.</p>}
      </div>

      {counts.duplicate > 0 && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeDuplicates}
            onChange={(e) => onIncludeDuplicates(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-brand-primary"
          />
          <span>
            Also import the {counts.duplicate} possible duplicate{counts.duplicate === 1 ? '' : 's'}
            <span className="block text-slate-500">
              They match an order from the last {preview.duplicateWindowDays} days on postcode, customer and product.
            </span>
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="btn-secondary" disabled={busy}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to columns
        </button>
        <button type="button" onClick={onImport} disabled={toImport === 0 || busy} className="btn-primary min-h-tap">
          <Upload className="h-4 w-4" aria-hidden />
          {busy ? 'Importing…' : toImport === 0 ? 'Nothing to import' : `Import ${toImport} order${toImport === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

// ---------- done ----------

function DoneStep({ result, onAgain }: { result: ImportCommitResult; onAgain: () => void }) {
  const skipped = [
    result.skippedExisting > 0 && `${result.skippedExisting} already existed`,
    result.skippedDuplicates > 0 && `${result.skippedDuplicates} possible duplicate${result.skippedDuplicates === 1 ? ' was' : 's were'} skipped`,
    result.failed > 0 && `${result.failed} need${result.failed === 1 ? 's' : ''} fixing in the file`,
  ].filter(Boolean);

  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-success" aria-hidden />
      <h2 className="mt-3 text-lg font-semibold">
        Imported {result.imported} order{result.imported === 1 ? '' : 's'}
      </h2>
      <p className="mt-1 text-sm text-slate-600">They are now awaiting scheduling and ready for the route planner.</p>
      {skipped.length > 0 && <p className="mt-2 text-sm text-slate-500">{skipped.join(' · ')}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link to="/office/orders?source=import" className="btn-primary">
          View imported orders
        </Link>
        <button type="button" onClick={onAgain} className="btn-secondary">
          Import another file
        </button>
      </div>
    </div>
  );
}
