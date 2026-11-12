import type { ExportFormat } from '@bedex/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { ApiError, downloadFile } from '../lib/api';
import { cn } from '../lib/cn';

interface Props {
  /** API path for a format, e.g. (f) => `/exports/orders?format=${f}` */
  path: (format: ExportFormat) => string;
  formats?: ExportFormat[];
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** DSH-06: one button per file format; downloads with the user's token. */
export function ExportButtons({ path, formats = ['csv', 'xlsx', 'pdf'], label, size = 'md', className }: Props) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      await downloadFile(path(format));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Download failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        {label && <span className="mr-1 text-slate-500">{label}</span>}
        {formats.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => run(f)}
            disabled={busy !== null}
            className={cn('btn-secondary', size === 'sm' ? 'gap-1 px-2 py-0.5 text-xs' : 'px-3 py-1.5')}
            aria-label={`Download ${f.toUpperCase()}`}
          >
            {size === 'md' && <Download className="h-3.5 w-3.5" aria-hidden />}
            {busy === f ? '…' : f.toUpperCase()}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
