import type { VanDto } from '@bedex/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power, Truck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../stores/auth';
import { Field, readApiError } from './fields';

interface FormState {
  id: string | null;
  registration: string;
  name: string;
  capacityUnits: string;
  capacityKg: string;
  capacityM3: string;
}

const EMPTY: FormState = { id: null, registration: '', name: '', capacityUnits: '', capacityKg: '', capacityM3: '' };
const toForm = (v: VanDto): FormState => ({
  id: v.id,
  registration: v.registration,
  name: v.name,
  capacityUnits: String(v.capacityUnits),
  capacityKg: v.capacityKg === null ? '' : String(v.capacityKg),
  capacityM3: v.capacityM3 === null ? '' : String(v.capacityM3),
});

/** DRV-02. */
export function VansPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const vans = useQuery({ queryKey: ['fleet', 'vans'], queryFn: () => api<VanDto[]>('/vans') });
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['fleet'] }), queryClient.invalidateQueries({ queryKey: ['planner'] })]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setErrors(null);
    const body = {
      registration: form.registration,
      name: form.name,
      capacityUnits: form.capacityUnits,
      capacityKg: form.capacityKg,
      capacityM3: form.capacityM3,
    };
    try {
      await api(form.id ? `/vans/${form.id}` : '/vans', { method: form.id ? 'PATCH' : 'POST', json: body });
      setForm(null);
      await refresh();
    } catch (err) {
      setErrors(readApiError(err));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(v: VanDto, active: boolean) {
    if (!active && !window.confirm(`Deactivate ${v.name} (${v.registration})? It won't be offered for new routes.`)) return;
    setRowError(null);
    try {
      await api(`/vans/${v.id}`, { method: 'PATCH', json: { active } });
      await refresh();
    } catch (err) {
      setRowError({ id: v.id, message: readApiError(err).message });
    }
  }

  const set = (key: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => f && { ...f, [key]: e.target.value });

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Vans</h1>
        {isAdmin && !form && (
          <button type="button" className="btn-primary" onClick={() => setForm(EMPTY)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add van
          </button>
        )}
      </div>
      {!isAdmin && <p className="rounded-md bg-surface px-3 py-2 text-slate-600">Only admins can add or change vans.</p>}

      {form && (
        <form onSubmit={save} className="card space-y-3 p-4" noValidate>
          <h2 className="font-semibold">{form.id ? `Edit ${form.name}` : 'New van'}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Registration" required value={form.registration} onChange={set('registration')} className="uppercase" error={errors?.fields.registration} />
            <Field label="Name" required value={form.name} onChange={set('name')} placeholder="Luton 1" error={errors?.fields.name} />
            <Field
              label="Capacity (units)"
              required
              inputMode="decimal"
              value={form.capacityUnits}
              onChange={set('capacityUnits')}
              error={errors?.fields.capacityUnits}
              hint="Used by the optimiser"
            />
            <Field label="Max weight (kg)" inputMode="decimal" value={form.capacityKg} onChange={set('capacityKg')} error={errors?.fields.capacityKg} hint="Optional" />
            <Field label="Max volume (m³)" inputMode="decimal" value={form.capacityM3} onChange={set('capacityM3')} error={errors?.fields.capacityM3} hint="Optional" />
          </div>
          {errors && (
            <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
              {errors.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => (setForm(null), setErrors(null))}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-left">
          <thead className="border-b border-border bg-surface text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Van</th>
              <th className="px-4 py-2.5 font-medium">Registration</th>
              <th className="px-4 py-2.5 text-right font-medium">Units</th>
              <th className="px-4 py-2.5 text-right font-medium">kg</th>
              <th className="px-4 py-2.5 text-right font-medium">m³</th>
              <th className="px-4 py-2.5 font-medium">Default for</th>
              <th className="px-4 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {vans.data?.map((v) => (
              <tr key={v.id} className={v.active ? '' : 'text-slate-400'}>
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2 font-medium">
                    <Truck className="h-4 w-4 text-slate-400" aria-hidden />
                    {v.name}
                    {!v.active && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-500">Inactive</span>}
                  </span>
                  {rowError?.id === v.id && <span className="mt-1 block text-xs text-danger">{rowError.message}</span>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">{v.registration}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{v.capacityUnits}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{v.capacityKg ?? '–'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{v.capacityM3 ?? '–'}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.defaultFor.join(', ') || '–'}</td>
                <td className="px-4 py-2.5">
                  {isAdmin && (
                    <div className="flex justify-end gap-1.5">
                      <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => (setForm(toForm(v)), setErrors(null))}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        Edit
                      </button>
                      <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setActive(v, !v.active)}>
                        <Power className="h-3.5 w-3.5" aria-hidden />
                        {v.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {vans.isPending && <p className="p-6 text-center text-slate-500">Loading…</p>}
        {vans.data?.length === 0 && <p className="p-6 text-center text-slate-500">No vans yet.</p>}
      </div>
    </div>
  );
}
