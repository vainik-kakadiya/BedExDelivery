import { type DriverDto, type DriverProgress, type RouteOption, type RouteStatus, type VanDto, formatUkDate, toLondonDate } from '@bedex/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MapPin, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { londonTime, relativeTime } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import { FALLBACK_POLL_MS, useLiveStatus } from '../../../lib/live';
import { useAuth } from '../../../stores/auth';
import { DriverForm } from './DriverForm';
import { RouteReassign } from './RouteReassign';
import { readApiError } from './fields';

const ROUTE_STATUS: Record<RouteStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-600' },
  released: { label: 'Released', className: 'bg-brand-primary/10 text-brand-primary' },
  in_progress: { label: 'On the road', className: 'bg-info/10 text-info' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
};

/** DRV-01, DRV-03 – DRV-05. */
export function DriversPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const today = toLondonDate();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || today;
  const now = useNow();
  const live = useLiveStatus((s) => s.status);
  const refetchInterval = live === 'live' ? false : FALLBACK_POLL_MS;

  const drivers = useQuery({ queryKey: ['fleet', 'drivers'], queryFn: () => api<DriverDto[]>('/drivers') });
  const vans = useQuery({ queryKey: ['fleet', 'vans'], queryFn: () => api<VanDto[]>('/vans') });
  const progress = useQuery({
    queryKey: ['fleet', 'progress', date],
    queryFn: () => api<DriverProgress[]>(`/drivers/progress?date=${date}`),
    refetchInterval,
  });
  const dayRoutes = useQuery({ queryKey: ['fleet', 'routes', date], queryFn: () => api<RouteOption[]>(`/routes?date=${date}`) });

  const [editing, setEditing] = useState<DriverDto | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['fleet'] }), queryClient.invalidateQueries({ queryKey: ['planner'] })]);

  async function setActive(d: DriverDto, active: boolean) {
    if (!active && !window.confirm(`Deactivate ${d.name}? They are signed out and can't sign in until reactivated. Their history is kept.`)) return;
    setRowError(null);
    try {
      await api(`/drivers/${d.id}`, { method: 'PATCH', json: { active } });
      await refresh();
    } catch (err) {
      setRowError({ id: d.id, message: readApiError(err).message });
    }
  }

  const progressFor = (id: string) => progress.data?.find((p) => p.driverId === id);

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Drivers</h1>
          <p className="text-slate-500">Progress for {date === today ? `today · ${formatUkDate(date)}` : formatUkDate(date)}</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label="Progress date"
            value={date}
            onChange={(e) => setParams(e.target.value && e.target.value !== today ? { date: e.target.value } : {}, { replace: true })}
            className="input w-auto"
          />
          {isAdmin && !editing && (
            <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              Add driver
            </button>
          )}
        </div>
      </div>

      {editing && vans.data && (
        <DriverForm
          key={editing === 'new' ? 'new' : editing.id}
          driver={editing === 'new' ? null : editing}
          vans={vans.data}
          onCancel={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}

      <div className="card divide-y divide-border">
        {drivers.isPending && <p className="p-6 text-center text-slate-500">Loading…</p>}
        {drivers.data?.length === 0 && <p className="p-6 text-center text-slate-500">No drivers yet.</p>}
        {drivers.data?.map((d) => {
          const p = progressFor(d.id);
          return (
            <div key={d.id} className={d.active ? '' : 'bg-surface/50'}>
              <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,1.6fr)_auto] lg:items-center">
                {/* Who (DRV-01) */}
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.name}
                    {!d.active && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">Inactive</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">{[d.email, d.phone].filter(Boolean).join(' · ')}</p>
                  <p className="text-xs text-slate-500">
                    {d.workStart}–{d.workEnd} · max {d.maxHours} h · {d.defaultVanName ?? 'no default van'}
                  </p>
                  {rowError?.id === d.id && <p className="mt-1 text-xs text-danger">{rowError.message}</p>}
                </div>

                {/* Today (DRV-03, DRV-04) */}
                <div className="min-w-0 space-y-1.5">
                  {!p?.routes.length && <p className="text-slate-400">No released route{date === today ? ' today' : ''}</p>}
                  {p?.routes.map((r) => {
                    const pct = r.stopsTotal ? Math.round((r.stopsCompleted / r.stopsTotal) * 100) : 0;
                    const status = ROUTE_STATUS[r.status];
                    return (
                      <div key={r.routeId}>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{r.name}</span>
                          <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', status.className)}>{status.label}</span>
                          <span className="text-xs text-slate-500">{r.vanName ?? 'no van'}</span>
                          <div className="flex min-w-32 flex-1 items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={r.stopsCompleted} aria-valuemax={r.stopsTotal}>
                              <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs tabular-nums text-slate-600">
                              {r.stopsCompleted}/{r.stopsTotal}
                            </span>
                          </div>
                        </div>
                        {r.currentStop && (
                          <p className="truncate text-xs text-slate-600">
                            Heading to #{r.currentStop.sequence} {r.currentStop.orderNumber} · {r.currentStop.customerName}, {r.currentStop.postcode}
                            {r.currentStop.eta && ` · ETA ${londonTime(r.currentStop.eta)}`}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {p?.lastLocation && (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline"
                      href={`https://www.google.com/maps/search/?api=1&query=${p.lastLocation.lat},${p.lastLocation.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapPin className="h-3 w-3" aria-hidden />
                      Last seen {relativeTime(p.lastLocation.recordedAt, now)}
                    </a>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap justify-end gap-1.5">
                  {!!p?.routes.length && (
                    <button
                      type="button"
                      className="btn-secondary px-2.5 py-1 text-xs"
                      aria-expanded={open === d.id}
                      onClick={() => setOpen(open === d.id ? null : d.id)}
                    >
                      {open === d.id ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                      Reassign
                    </button>
                  )}
                  {isAdmin && (
                    <>
                      <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setEditing(d)}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                        Edit
                      </button>
                      <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setActive(d, !d.active)}>
                        <Power className="h-3.5 w-3.5" aria-hidden />
                        {d.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {open === d.id &&
                p?.routes.map((r) => (
                  <RouteReassign
                    key={r.routeId}
                    route={r}
                    driverId={d.id}
                    drivers={drivers.data ?? []}
                    vans={vans.data ?? []}
                    dayRoutes={dayRoutes.data ?? []}
                    onChanged={refresh}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
