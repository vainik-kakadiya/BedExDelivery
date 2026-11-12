import { DEFAULT_SETTINGS, ROUTE_END_TYPES, ROUTE_END_TYPE_LABELS, SETTING_LABELS, type SettingKey, type Settings } from '@bedex/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../stores/auth';

const GROUPS: { title: string; keys: SettingKey[] }[] = [
  { title: 'Route planning', keys: ['routes.defaultEndType', 'orders.defaultServiceMinutes'] },
  { title: 'Customer tracking page', keys: ['tracking.showProofPhoto', 'tracking.showDriverName', 'tracking.showLiveLocation'] },
  { title: 'Drivers & data', keys: ['driver.locationIntervalSeconds', 'import.duplicateWindowDays', 'retention.driverLocationDays', 'retention.photoDays'] },
];

/** RTE-02 defaults and other admin settings. Office users can view them. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const changed = draft && settings.data ? (Object.keys(draft) as SettingKey[]).filter((k) => draft[k] !== settings.data[k]) : [];

  async function save() {
    if (!draft) return;
    setStatus(null);
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, draft[k]]));
      await api('/settings', { method: 'PATCH', json: patch });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['planner'] });
      setStatus({ ok: true, text: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save settings.' });
    }
  }

  const input = (key: SettingKey) => {
    if (!draft) return null;
    const value = draft[key];
    const set = (v: string | number | boolean) => setDraft({ ...draft, [key]: v });
    if (key === 'routes.defaultEndType') {
      return (
        <select disabled={!isAdmin} value={String(value)} onChange={(e) => set(e.target.value)} className="input w-48 py-1.5">
          {ROUTE_END_TYPES.map((t) => (
            <option key={t} value={t}>
              {ROUTE_END_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      );
    }
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
      return <input type="checkbox" disabled={!isAdmin} checked={Boolean(value)} onChange={(e) => set(e.target.checked)} className="h-4 w-4" />;
    }
    return (
      <input
        type="number"
        min={0}
        disabled={!isAdmin}
        value={Number(value)}
        onChange={(e) => set(Number(e.target.value))}
        className="input w-28 py-1.5 text-right"
      />
    );
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        {isAdmin && (
          <button type="button" className="btn-primary" disabled={changed.length === 0} onClick={save}>
            Save {changed.length > 0 && `(${changed.length})`}
          </button>
        )}
      </div>
      {!isAdmin && <p className="rounded-md bg-surface px-3 py-2 text-slate-600">Only admins can change settings.</p>}
      {status && (
        <p role="status" className={`rounded-md px-3 py-2 ${status.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
          {status.text}
        </p>
      )}
      {settings.isPending && <p className="text-slate-500">Loading…</p>}
      {draft &&
        GROUPS.map((g) => (
          <section key={g.title} className="card">
            <h2 className="border-b border-border px-4 py-2.5 font-semibold">{g.title}</h2>
            <ul className="divide-y divide-border">
              {g.keys.map((key) => (
                <li key={key} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <label className="text-slate-700">{SETTING_LABELS[key]}</label>
                  {input(key)}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
