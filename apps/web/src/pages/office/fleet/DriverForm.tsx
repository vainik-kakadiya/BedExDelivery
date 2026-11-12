import type { DriverDto, VanDto } from '@bedex/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../../lib/api';
import { Field, readApiError } from './fields';

interface Props {
  driver: DriverDto | null;
  vans: VanDto[];
  onDone: () => void;
  onCancel: () => void;
}

/** DRV-01: create a driver (with their login) or edit one. */
export function DriverForm({ driver, vans, onDone, onCancel }: Props) {
  const [f, setF] = useState({
    name: driver?.name ?? '',
    email: driver?.email ?? '',
    phone: driver?.phone ?? '',
    password: '',
    workStart: driver?.workStart ?? '08:00',
    workEnd: driver?.workEnd ?? '17:00',
    maxHours: String(driver?.maxHours ?? 10),
    defaultVanId: driver?.defaultVanId ?? '',
    homeAddress: driver?.homeAddress ?? '',
    homePostcode: driver?.homePostcode ?? '',
    homeLat: driver?.homeLat === null || driver?.homeLat === undefined ? '' : String(driver.homeLat),
    homeLng: driver?.homeLng === null || driver?.homeLng === undefined ? '' : String(driver.homeLng),
  });
  const [errors, setErrors] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [key]: e.target.value }));
  const err = (key: string) => errors?.fields[key];

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors(null);
    try {
      await api(driver ? `/drivers/${driver.id}` : '/drivers', { method: driver ? 'PATCH' : 'POST', json: f });
      onDone();
    } catch (error) {
      setErrors(readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-4 p-4" noValidate>
      <h2 className="font-semibold">{driver ? `Edit ${driver.name}` : 'New driver'}</h2>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Driver & login</legend>
        <Field label="Full name" required value={f.name} onChange={set('name')} error={err('name')} />
        <Field label="Email" type="email" autoComplete="off" value={f.email} onChange={set('email')} error={err('email')} />
        <Field label="Mobile" type="tel" autoComplete="off" value={f.phone} onChange={set('phone')} error={err('phone')} hint="Can sign in with email or mobile" />
        <Field
          label={driver ? 'New password' : 'Password'}
          type="password"
          autoComplete="new-password"
          required={!driver}
          value={f.password}
          onChange={set('password')}
          error={err('password')}
          hint={driver ? 'Leave blank to keep it. Changing it signs them out.' : 'At least 12 characters'}
        />
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Working day (used by the optimiser)</legend>
        <Field label="Starts" type="time" value={f.workStart} onChange={set('workStart')} error={err('workStart')} />
        <Field label="Finishes" type="time" value={f.workEnd} onChange={set('workEnd')} error={err('workEnd')} />
        <Field label="Max hours on the road" inputMode="decimal" value={f.maxHours} onChange={set('maxHours')} error={err('maxHours')} />
        <label className="block text-xs font-medium text-slate-600">
          Default van
          <select value={f.defaultVanId} onChange={set('defaultVanId')} className="input mt-1">
            <option value="">None</option>
            {vans
              .filter((v) => v.active || v.id === f.defaultVanId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.registration}
                </option>
              ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Home (optional – for routes that end at the driver&apos;s home)
        </legend>
        <Field label="Address" value={f.homeAddress} onChange={set('homeAddress')} error={err('homeAddress')} />
        <Field label="Postcode" value={f.homePostcode} onChange={set('homePostcode')} className="uppercase" error={err('homePostcode')} />
        <Field label="Latitude" inputMode="decimal" placeholder="51.51" value={f.homeLat} onChange={set('homeLat')} error={err('homeLat')} />
        <Field label="Longitude" inputMode="decimal" placeholder="-0.27" value={f.homeLng} onChange={set('homeLng')} error={err('homeLng')} />
      </fieldset>

      {errors && (
        <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
          {errors.message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : driver ? 'Save changes' : 'Create driver'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
