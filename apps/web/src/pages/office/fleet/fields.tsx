import type { InputHTMLAttributes, ReactNode } from 'react';
import { ApiError } from '../../../lib/api';

/** Labelled input with an inline error, for the fleet forms. */
export function Field({
  label,
  error,
  hint,
  ...props
}: { label: string; error?: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      {label}
      <input {...props} className={`input mt-1 ${error ? 'border-danger' : ''} ${props.className ?? ''}`} aria-invalid={!!error} />
      {hint && !error && <span className="mt-0.5 block font-normal text-slate-500">{hint}</span>}
      {error && <span className="mt-0.5 block font-normal text-danger">{error}</span>}
    </label>
  );
}

/** Split an API error into a message and per-field errors. */
export function readApiError(err: unknown): { message: string; fields: Record<string, string> } {
  if (!(err instanceof ApiError)) return { message: 'Something went wrong. Please try again.', fields: {} };
  const raw = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {};
  const fields = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v[0] ?? 'Invalid']));
  return { message: Object.keys(fields).length ? 'Please fix the highlighted fields.' : err.message, fields };
}
