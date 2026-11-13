import type { Depot } from '@bedex/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Pencil, Plus, Star } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../stores/auth';

interface FormState {
  id: string | null;
  name: string;
  address: string;
  postcode: string;
  lat: string;
  lng: string;
  isDefault: boolean;
  active: boolean;
}

const EMPTY: FormState = { id: null, name: '', address: '', postcode: '', lat: '', lng: '', isDefault: false, active: true };

/** RTE-02: depots routes start from (and may return to). */
export function DepotsPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const depots = useQuery({ queryKey: ['depots'], queryFn: () => api<Depot[]>('/depots') });
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const edit = (d: Depot) =>
    setForm({ id: d.id, name: d.name, address: d.address, postcode: d.postcode, lat: String(d.lat), lng: String(d.lng), isDefault: d.isDefault, active: d.active });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      address: form.address,
      postcode: form.postcode,
      lat: Number(form.lat),
      lng: Number(form.lng),
      isDefault: form.isDefault,
      active: form.active,
    };
    try {
      await api(form.id ? `/depots/${form.id}` : '/depots', { method: form.id ? 'PATCH' : 'POST', json: body });
      setForm(null);
      await queryClient.invalidateQueries({ queryKey: ['depots'] });
      await queryClient.invalidateQueries({ queryKey: ['planner'] });
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
        setError(fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ') : err.message);
      } else setError('Could not save the depot.');
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof FormState, label: string, props: Record<string, unknown> = {}) => (
    <label className="text-xs font-medium text-slate-600">
      {label}
      <input
        required
        value={String(form?.[key] ?? '')}
        onChange={(e) => setForm((f) => f && { ...f, [key]: e.target.value })}
        className="input mt-1"
        {...props}
      />
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Depots</h1>
        {isAdmin && !form && (
          <button type="button" className="btn-primary" onClick={() => setForm(EMPTY)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add depot
          </button>
        )}
      </div>

      {form && (
        <form onSubmit={save} className="card space-y-3 p-4">
          <h2 className="font-semibold">{form.id ? 'Edit depot' : 'New depot'}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', 'Name', { maxLength: 100 })}
            {field('postcode', 'Postcode', { className: 'input mt-1 uppercase' })}
            <div className="sm:col-span-2">{field('address', 'Address', { maxLength: 300 })}</div>
            {field('lat', 'Latitude', { inputMode: 'decimal', placeholder: '51.529' })}
            {field('lng', 'Longitude', { inputMode: 'decimal', placeholder: '-0.267' })}
          </div>
          <p className="text-xs text-slate-500">
            Coordinates: right-click the depot in{' '}
            <a href="https://www.google.com/maps" target="_blank" rel="noreferrer" className="text-brand-primary hover:underline">
              Google Maps
            </a>{' '}
            and click the numbers to copy them.
          </p>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
              Default start depot
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active
            </label>
          </div>
          {error && (
            <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card divide-y divide-border">
        {depots.isPending && <p className="p-6 text-center text-slate-500">Loading…</p>}
        {depots.data?.length === 0 && <p className="p-6 text-center text-slate-500">No depots yet. Add one to start planning routes.</p>}
        {depots.data?.map((d) => (
          <div key={d.id} className="flex items-center gap-3 px-4 py-3">
            <Building2 className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {d.name}
                {d.isDefault && (
                  <span className="inline-flex items-center gap-1 rounded bg-brand-primary/10 px-1.5 py-0.5 text-[11px] text-brand-primary">
                    <Star className="h-3 w-3" aria-hidden />
                    Default
                  </span>
                )}
                {!d.active && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">Inactive</span>}
              </p>
              <p className="truncate text-slate-500">
                {d.address}, {d.postcode} · {d.lat.toFixed(4)}, {d.lng.toFixed(4)}
              </p>
            </div>
            {isAdmin && (
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => edit(d)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Edit
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
