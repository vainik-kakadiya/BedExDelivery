import type { DriverDto, DriverProgressRoute, RouteOption, VanDto } from '@bedex/shared';
import { ArrowRightLeft, UserRoundCog } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '../../../components/StatusBadge';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { londonTime } from '../../../lib/format';
import { readApiError } from './fields';

interface Props {
  route: DriverProgressRoute;
  driverId: string;
  drivers: DriverDto[];
  vans: VanDto[];
  /** Every route on the same day (targets for moving stops). */
  dayRoutes: RouteOption[];
  onChanged: () => Promise<unknown>;
}

/** DRV-03 / DRV-05: reassign the whole route, or move outstanding stops to another route. */
export function RouteReassign({ route, driverId, drivers, vans, dayRoutes, onChanged }: Props) {
  const [newDriver, setNewDriver] = useState(driverId);
  const [newVan, setNewVan] = useState(route.vanId ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const targets = dayRoutes.filter((r) => r.id !== route.routeId && r.status !== 'completed');
  const outstanding = route.stops.filter((s) => !s.completedAt);
  const driverName = (id: string | null) => drivers.find((d) => d.id === id)?.name ?? 'no driver';

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await onChanged();
      setMessage({ ok: true, text: label });
    } catch (err) {
      setMessage({ ok: false, text: readApiError(err).message });
    } finally {
      setBusy(false);
    }
  }

  const reassign = () => {
    const toDriver = drivers.find((d) => d.id === newDriver);
    if (!window.confirm(`Give ${route.name} to ${toDriver?.name ?? 'no driver'}? Both drivers' apps update straight away.`)) return;
    void run(`${route.name} reassigned to ${toDriver?.name}`, () =>
      api(`/routes/${route.routeId}`, { method: 'PATCH', json: { driverId: newDriver, vanId: newVan || null } }),
    );
  };

  const move = () => {
    const to = targets.find((r) => r.id === target);
    if (!to) return;
    if (!window.confirm(`Move ${selected.size} stop${selected.size > 1 ? 's' : ''} to ${to.name} (${driverName(to.driverId)})? Both drivers' apps update straight away.`)) return;
    void run(`${selected.size} stop${selected.size > 1 ? 's' : ''} moved to ${to.name}`, async () => {
      await api(`/routes/${route.routeId}/stops/transfer`, { method: 'POST', json: { orderIds: [...selected], toRouteId: to.id } });
      setSelected(new Set());
    });
  };

  return (
    <div className="space-y-4 border-t border-border bg-surface/60 px-4 py-4">
      <div className="flex flex-wrap items-end gap-2">
        <UserRoundCog className="mb-2 h-4 w-4 text-slate-400" aria-hidden />
        <label className="text-xs font-medium text-slate-600">
          Whole route: driver
          <select value={newDriver} onChange={(e) => setNewDriver(e.target.value)} className="input mt-1 w-48 py-1.5">
            {drivers
              .filter((d) => d.active || d.id === driverId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Van
          <select value={newVan} onChange={(e) => setNewVan(e.target.value)} className="input mt-1 w-48 py-1.5">
            <option value="">No van</option>
            {vans
              .filter((v) => v.active || v.id === route.vanId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.registration}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-secondary py-1.5"
          disabled={busy || (newDriver === driverId && newVan === (route.vanId ?? ''))}
          onClick={reassign}
        >
          Reassign route
        </button>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-slate-600">Individual stops – tick outstanding stops to move them to another route</p>
        <ol className="card divide-y divide-border">
          {route.stops.map((s) => {
            const done = !!s.completedAt;
            return (
              <li key={s.stopId} className={cn('flex items-center gap-3 px-3 py-1.5', done && 'text-slate-400')}>
                <input
                  type="checkbox"
                  aria-label={`Select ${s.orderNumber}`}
                  disabled={done || busy}
                  checked={selected.has(s.orderId)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.orderId);
                      else next.delete(s.orderId);
                      return next;
                    })
                  }
                  className="h-4 w-4"
                />
                <span className="w-6 text-right text-xs tabular-nums">{s.sequence}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{s.orderNumber}</span> {s.customerName} · {s.postcode}
                </span>
                <StatusBadge status={s.status} />
                <span className="w-24 text-right text-xs tabular-nums">
                  {done ? `Done ${londonTime(s.completedAt!)}` : s.eta ? `ETA ${londonTime(s.eta)}` : ''}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-xs text-brand-primary hover:underline disabled:opacity-40"
            disabled={outstanding.length === 0}
            onClick={() => setSelected(new Set(outstanding.map((s) => s.orderId)))}
          >
            Select all outstanding ({outstanding.length})
          </button>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="input w-80 py-1.5" aria-label="Move to route">
            <option value="">Move to route…</option>
            {targets.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {driverName(r.driverId)} · {r.status.replace('_', ' ')}
              </option>
            ))}
          </select>
          <button type="button" className="btn-primary py-1.5" disabled={busy || selected.size === 0 || !target} onClick={move}>
            <ArrowRightLeft className="h-4 w-4" aria-hidden />
            Move {selected.size || ''} stop{selected.size === 1 ? '' : 's'}
          </button>
          {targets.length === 0 && <span className="text-xs text-slate-500">No other routes this day – create one in the route planner.</span>}
        </div>
      </div>

      {message && (
        <p role="status" className={cn('rounded px-3 py-2 text-sm', message.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>
          {message.text}
        </p>
      )}
    </div>
  );
}
