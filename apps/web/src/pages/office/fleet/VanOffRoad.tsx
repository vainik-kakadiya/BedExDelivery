import {
  type RouteStatus,
  type VanDeactivateInput,
  type VanDto,
  type VanImpact,
  type VanImpactRoute,
  type VanRouteAction,
  formatUkDate,
  toLondonDate,
} from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { readApiError } from './fields';

const ROUTE_STATUS: Record<RouteStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-600' },
  released: { label: 'Released', className: 'bg-brand-primary/10 text-brand-primary' },
  in_progress: { label: 'On the road', className: 'bg-info/10 text-info' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
};

const REASONS = ['Breakdown', 'Accident', 'Service / MOT', 'Repairs'];

interface Decision {
  action: VanRouteAction | '';
  vanId: string;
  toRouteId: string;
}

/** What a route can do without this van; started routes can't be unplanned or left without a van. */
function optionsFor(r: VanImpactRoute): { action: VanRouteAction; label: string; disabled?: string }[] {
  const started = r.status === 'in_progress';
  const fitting = r.spareVans.filter((v) => v.fits || r.status === 'draft');
  return [
    {
      action: 'swap',
      label: 'Use another van',
      disabled: r.spareVans.length === 0 ? 'No spare van that day' : fitting.length === 0 ? 'No spare van big enough for this load' : undefined,
    },
    {
      action: 'transfer',
      label: `Move ${r.stopsOutstanding === r.stopsTotal ? 'its' : 'the outstanding'} stops to another route`,
      disabled: r.transferTargets.length === 0 ? 'No other route that day' : undefined,
    },
    ...(started
      ? []
      : [
          {
            action: 'unassign' as const,
            label: r.status === 'released' ? 'Keep stops, no van – back to draft' : 'Keep stops, choose a van later',
          },
          { action: 'unplan' as const, label: 'Remove the route – orders go back to be planned' },
        ]),
  ];
}

/** A sensible starting choice: a spare van that fits, else another route, else keep the stops without a van. */
function defaultDecision(r: VanImpactRoute): Decision {
  const spare = r.spareVans.find((v) => v.fits);
  if (spare) return { action: 'swap', vanId: spare.id, toRouteId: '' };
  if (r.status === 'in_progress') return { action: r.transferTargets.length ? 'transfer' : '', vanId: '', toRouteId: r.transferTargets[0]?.id ?? '' };
  return { action: 'unassign', vanId: '', toRouteId: '' };
}

interface Props {
  van: VanDto;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}

/** DRV-02: take a van off the road (e.g. a breakdown) and decide what happens to its routes. */
export function VanOffRoad({ van, onDone, onCancel }: Props) {
  const impact = useQuery({
    queryKey: ['fleet', 'vans', van.id, 'impact'],
    queryFn: () => api<VanImpact>(`/vans/${van.id}/impact`),
    staleTime: 0,
  });
  const [reason, setReason] = useState('Breakdown');
  const [picked, setPicked] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const routes = impact.data?.routes ?? [];
  const today = toLondonDate();
  const decision = (r: VanImpactRoute) => picked[r.id] ?? defaultDecision(r);
  const set = (r: VanImpactRoute, patch: Partial<Decision>) => setPicked((p) => ({ ...p, [r.id]: { ...decision(r), ...patch } }));

  const incomplete = routes.filter((r) => {
    const d = decision(r);
    return !d.action || (d.action === 'swap' && !d.vanId) || (d.action === 'transfer' && !d.toRouteId);
  });
  // The same spare van can't replace two routes on the same day.
  const doubleBooked = routes.filter(
    (r, i) => decision(r).action === 'swap' && routes.some((o, j) => j < i && o.date === r.date && decision(o).action === 'swap' && decision(o).vanId === decision(r).vanId),
  );

  async function submit() {
    setSaving(true);
    setError(null);
    const body: VanDeactivateInput = {
      reason: reason.trim() || null,
      routes: routes.map((r) => {
        const d = decision(r);
        if (d.action === 'swap') return { routeId: r.id, action: 'swap', vanId: d.vanId };
        if (d.action === 'transfer') return { routeId: r.id, action: 'transfer', toRouteId: d.toRouteId };
        return { routeId: r.id, action: d.action as 'unassign' | 'unplan' };
      }),
    };
    try {
      await api(`/vans/${van.id}/deactivate`, { method: 'POST', json: body });
      await onDone();
    } catch (err) {
      setError(readApiError(err).message);
      // Someone may have changed the routes meanwhile: show the current picture.
      void impact.refetch();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4 border-warning/40 p-4" aria-labelledby="off-road-title">
      <div className="flex items-start gap-3">
        <span className="rounded-full bg-warning/10 p-2 text-warning">
          <Wrench className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="off-road-title" className="font-semibold">
            Take {van.name} ({van.registration}) off the road
          </h2>
          <p className="text-sm text-slate-600">
            It won't be offered for planning until you reactivate it. Routes that use it from today on need a decision first.
          </p>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600">
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="input mt-1 sm:w-80" placeholder="e.g. Breakdown on the A12" />
        </label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs', reason === r ? 'border-brand-primary bg-brand-primary/10 text-brand-primary' : 'border-border text-slate-600 hover:bg-surface')}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {impact.isPending && <p className="text-sm text-slate-500">Checking its routes…</p>}
      {impact.isError && <p className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{readApiError(impact.error).message}</p>}
      {impact.data && routes.length === 0 && <p className="rounded bg-surface px-3 py-2 text-sm text-slate-600">It isn't on any route from today on, so nothing else changes.</p>}

      {routes.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            {routes.length} route{routes.length > 1 ? 's use' : ' uses'} this van
          </p>
          {routes.map((r) => {
            const d = decision(r);
            const status = ROUTE_STATUS[r.status];
            return (
              <fieldset key={r.id} className="rounded-md border border-border p-3">
                <legend className="sr-only">What happens to {r.name}</legend>
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-semibold">{r.name}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', status.className)}>{status.label}</span>
                  <span className="text-slate-600">
                    {r.date === today ? 'Today' : formatUkDate(r.date)} · {r.driverName ?? 'No driver'} · {r.stopsOutstanding}
                    {r.stopsOutstanding !== r.stopsTotal && ` of ${r.stopsTotal}`} stop{r.stopsTotal === 1 ? '' : 's'} to do · {Math.round(r.loadUnits * 10) / 10} units
                  </span>
                </div>
                <div className="space-y-1.5">
                  {optionsFor(r).map((o) => (
                    <div key={o.action} className="flex flex-wrap items-center gap-2">
                      <label className={cn('flex items-center gap-2 text-sm', o.disabled && 'text-slate-400')}>
                        <input
                          type="radio"
                          name={`route-${r.id}`}
                          className="h-4 w-4"
                          checked={d.action === o.action}
                          disabled={!!o.disabled || saving}
                          onChange={() => set(r, { action: o.action })}
                        />
                        {o.label}
                        {o.disabled && <span className="text-xs">({o.disabled})</span>}
                      </label>
                      {o.action === 'swap' && d.action === 'swap' && (
                        <select value={d.vanId} onChange={(e) => set(r, { vanId: e.target.value })} className="input w-full py-1 text-sm sm:w-64" aria-label={`Replacement van for ${r.name}`}>
                          <option value="">Choose a van…</option>
                          {r.spareVans.map((v) => (
                            <option key={v.id} value={v.id} disabled={!v.fits && r.status !== 'draft'}>
                              {v.name} · {v.registration} · {v.capacityUnits} units{v.fits ? '' : ' (too small)'}
                            </option>
                          ))}
                        </select>
                      )}
                      {o.action === 'transfer' && d.action === 'transfer' && (
                        <select value={d.toRouteId} onChange={(e) => set(r, { toRouteId: e.target.value })} className="input w-full py-1 text-sm sm:w-64" aria-label={`Route to take ${r.name}'s stops`}>
                          <option value="">Choose a route…</option>
                          {r.transferTargets.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} · {t.driverName ?? 'no driver'} · {ROUTE_STATUS[t.status].label.toLowerCase()}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
                {d.action === 'swap' && r.status !== 'draft' && <p className="mt-2 text-xs text-slate-500">{r.driverName ?? 'The driver'}'s app updates straight away with the new van.</p>}
                {d.action === 'transfer' && (
                  <p className="mt-2 text-xs text-slate-500">
                    {r.status === 'in_progress'
                      ? `Completed stops stay on ${r.name}; the rest go to the end of the other route. Both drivers' apps update.`
                      : `${r.name} is removed once its stops have moved. Re-optimise the other route afterwards if needed.`}
                  </p>
                )}
                {d.action === 'unplan' && <p className="mt-2 text-xs text-slate-500">Its orders appear as unassigned in the route planner for {r.date === today ? 'today' : formatUkDate(r.date)}.</p>}
              </fieldset>
            );
          })}
        </div>
      )}

      {(incomplete.length > 0 || doubleBooked.length > 0) && routes.length > 0 && (
        <p className="flex items-center gap-2 rounded bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {doubleBooked.length
            ? `The same spare van is chosen for two routes on ${formatUkDate(doubleBooked[0]!.date)}.`
            : `Choose what happens to ${incomplete.map((r) => r.name).join(', ')}. If nothing fits, add a route or a van in the route planner first.`}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn bg-danger text-white hover:bg-danger/90"
          disabled={saving || !impact.data || incomplete.length > 0 || doubleBooked.length > 0}
          onClick={submit}
        >
          {saving ? 'Saving…' : routes.length ? 'Take off the road and update routes' : 'Take off the road'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </section>
  );
}
