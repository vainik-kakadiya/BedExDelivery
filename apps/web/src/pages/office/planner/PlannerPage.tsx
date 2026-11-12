import {
  ROUTE_END_TYPES,
  ROUTE_END_TYPE_LABELS,
  type OptimiseJob,
  type PlannerRoute,
  type PlannerState,
  type RouteEndType,
  formatUkDate,
  toLondonDate,
} from '@bedex/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, MapPinOff, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { addDays } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import { FALLBACK_POLL_MS, useLiveStatus } from '../../../lib/live';
import { MAPS_KEY, PlannerMap } from './PlannerMap';
import { type RouteActions, RouteCard } from './RouteCard';
import { UnassignedPanel } from './UnassignedPanel';
import { type VehicleChoice, VehiclesPanel } from './VehiclesPanel';
import { type DragPayload, insertInto, routeColour } from './shared';

/** RTE-01 – RTE-10. */
export function PlannerPage() {
  const queryClient = useQueryClient();
  const today = toLondonDate();
  const [params, setParams] = useSearchParams();
  // Planning is usually for tomorrow.
  const date = params.get('date') || addDays(today, 1);
  const setDate = (d: string) => setParams(d ? { date: d } : {}, { replace: true });

  const live = useLiveStatus((s) => s.status);
  const plan = useQuery({
    queryKey: ['planner', date],
    queryFn: () => api<PlannerState>(`/routes/plan?date=${date}`),
    refetchInterval: live === 'live' ? false : FALLBACK_POLL_MS,
  });
  const state = plan.data;

  // --- optimisation inputs (RTE-02, RTE-03) ---
  const [depotId, setDepotId] = useState('');
  const [endType, setEndType] = useState<RouteEndType>('depot');
  const [vehicles, setVehicles] = useState<VehicleChoice>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const initialisedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state || initialisedFor.current === state.date) return;
    initialisedFor.current = state.date;
    setDepotId(state.defaultDepotId ?? '');
    setEndType(state.defaultEndType);
    setExcluded(new Set());
    // Default: everyone without a released route that day, each in their own van.
    const taken = new Set(state.routes.filter((r) => r.status !== 'draft' && r.vanId).map((r) => r.vanId));
    const next: VehicleChoice = {};
    for (const d of state.drivers) {
      const vanId =
        (d.defaultVanId && !taken.has(d.defaultVanId) ? d.defaultVanId : state.vans.find((v) => !taken.has(v.id))?.id) ?? '';
      const on = d.busyRouteNames.length === 0 && vanId !== '';
      if (on) taken.add(vanId);
      next[d.id] = { on, vanId };
    }
    setVehicles(next);
  }, [state]);

  // --- actions ---
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; items: string[] } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['planner', date] });
      setBusy(null);
    }
  }

  /** RTE-09: edits to a released route reach the driver straight away. */
  const confirmReleased = (...routes: (PlannerRoute | undefined)[]) => {
    const released = routes.filter((r): r is PlannerRoute => r?.status === 'released');
    return (
      released.length === 0 ||
      window.confirm(`${released.map((r) => r.name).join(' and ')} ${released.length > 1 ? 'are' : 'is'} released. The driver will see this change immediately. Continue?`)
    );
  };
  const routeById = (id: string | null) => state?.routes.find((r) => r.id === id);
  const putStops = (route: PlannerRoute, orderIds: string[]) =>
    run(`Updating ${route.name}`, () => api(`/routes/${route.id}/stops`, { method: 'PUT', json: { orderIds } }));

  const actions: RouteActions = {
    setStops: (route, orderIds) => {
      if (confirmReleased(route)) void putStops(route, orderIds);
    },
    drop: (route, payload: DragPayload, index) => {
      const ids = route.stops.map((s) => s.order.id);
      const from = routeById(payload.fromRouteId);
      if (!confirmReleased(route, from && from.id !== route.id ? from : undefined)) return;
      void putStops(route, insertInto(ids, payload.orderId, index));
    },
    patch: (route, body) => {
      if (route.status !== 'draft' && !window.confirm(`${route.name} is ${route.status.replace('_', ' ')}. The driver will see this change. Continue?`)) return;
      void run(`Updating ${route.name}`, () => api(`/routes/${route.id}`, { method: 'PATCH', json: body }));
    },
    release: (route) => {
      const warnings = route.warnings.filter((w) => w.code !== 'empty');
      const msg = warnings.length
        ? `${route.name} has warnings:\n\n• ${warnings.map((w) => w.message).join('\n• ')}\n\nRelease it to ${route.driverName ?? 'the driver'} anyway?`
        : `Release ${route.name} to ${route.driverName ?? 'the driver'}? It will appear in their app.`;
      if (window.confirm(msg)) void run(`Releasing ${route.name}`, () => api(`/routes/${route.id}/release`, { method: 'POST' }));
    },
    unrelease: (route) => {
      if (window.confirm(`Move ${route.name} back to draft? It disappears from ${route.driverName ?? 'the driver'}'s app until released again.`)) {
        void run(`Updating ${route.name}`, () => api(`/routes/${route.id}/unrelease`, { method: 'POST' }));
      }
    },
    remove: (route) => {
      if (window.confirm(`Delete ${route.name}? Its ${route.stops.length} orders go back to unassigned.`)) {
        void run(`Deleting ${route.name}`, () => api(`/routes/${route.id}`, { method: 'DELETE' }));
      }
    },
    recalculate: (route) => void run(`Recalculating ${route.name}`, () => api(`/routes/${route.id}/recalculate`, { method: 'POST' })),
    reoptimise: (route) => {
      if (!confirmReleased(route)) return;
      void run(`Re-optimising ${route.name}`, async () => {
        const res = await api<{ skipped: { orderNumber: string; reason: string }[] }>(`/routes/${route.id}/reoptimise`, { method: 'POST' });
        if (res.skipped.length) setNotice({ title: `${route.name}: some stops don't fit`, items: res.skipped.map((s) => `${s.orderNumber}: ${s.reason}`) });
      });
    },
  };

  const takeOff = (payload: DragPayload) => {
    const from = routeById(payload.fromRouteId);
    if (from && confirmReleased(from)) void putStops(from, from.stops.map((s) => s.order.id).filter((id) => id !== payload.orderId));
  };
  const addTo = (orderId: string, routeId: string) => {
    const route = routeById(routeId);
    if (route && confirmReleased(route)) void putStops(route, [...route.stops.map((s) => s.order.id), orderId]);
  };

  // --- optimise job (RTE-04, RTE-05) ---
  const [job, setJob] = useState<OptimiseJob | null>(null);
  // Set in the effect body as well as cleared in cleanup: React StrictMode mounts
  // twice in development, and a cleanup-only ref would stay false for good.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const now = useNow(job?.status === 'running' ? 1000 : 60_000);

  // Drivers/vans already on a released or started route that day are left out (the API refuses them too).
  const busyDrivers = new Set(state?.drivers.filter((d) => d.busyRouteNames.length > 0).map((d) => d.id));
  const busyVans = new Set(state?.routes.filter((r) => r.status !== 'draft' && r.vanId).map((r) => r.vanId));
  const chosen = Object.entries(vehicles)
    .filter(([driverId, v]) => v.on && v.vanId && !busyDrivers.has(driverId) && !busyVans.has(v.vanId))
    .map(([driverId, v]) => ({ driverId, vanId: v.vanId }));
  const vanClash = new Set(chosen.map((c) => c.vanId)).size !== chosen.length;
  const drafts = state?.routes.filter((r) => r.status === 'draft') ?? [];
  // Ticked unassigned orders, plus orders already on drafts (re-planned with the rest).
  const toPlan = state
    ? [
        ...state.unassigned.filter((o) => o.lat !== null && o.lng !== null && !excluded.has(o.id)).map((o) => o.id),
        ...drafts.flatMap((r) => r.stops.map((s) => s.order.id)),
      ]
    : [];

  async function optimise() {
    if (!state) return;
    if (drafts.length && !window.confirm(`Optimising replaces the ${drafts.length} draft route${drafts.length > 1 ? 's' : ''} for ${formatUkDate(date)}. Released routes are kept. Continue?`)) return;
    setError(null);
    setNotice(null);
    try {
      let current = await api<OptimiseJob>('/routes/optimise', {
        method: 'POST',
        json: { date, depotId, endType, vehicles: chosen, orderIds: toPlan },
      });
      setJob(current);
      while (current.status === 'running') {
        await new Promise((r) => setTimeout(r, 1000));
        if (!mounted.current) return;
        current = await api<OptimiseJob>(`/routes/optimise/${current.id}`);
        setJob(current);
      }
      await queryClient.invalidateQueries({ queryKey: ['planner', date] });
      if (current.status === 'failed') setError(current.error ?? 'Optimisation failed');
      else if (current.result?.skipped.length) {
        setNotice({
          title: `${current.result.skipped.length} order${current.result.skipped.length > 1 ? 's' : ''} could not be planned`,
          items: current.result.skipped.map((s) => `${s.orderNumber || 'Order'}: ${s.reason}`),
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start optimisation.');
      setJob(null);
    }
  }

  const running = job?.status === 'running';
  const disabled = busy !== null || running;
  const depot = state?.depots.find((d) => d.id === depotId);
  const canOptimise = !!state && !disabled && chosen.length > 0 && !vanClash && !!depotId && toPlan.length > 0;
  const optimiseHint = !state
    ? ''
    : !depotId
      ? 'Add a depot first'
      : chosen.length === 0
        ? 'Choose at least one driver and van'
        : vanClash
          ? 'Each van can only be used once'
          : toPlan.length === 0
            ? 'No orders to plan'
            : `${toPlan.length} orders · ${chosen.length} vans`;

  const routesList = state?.routes.map((route, i) => (
    <RouteCard
      key={route.id}
      route={route}
      colour={routeColour(i)}
      state={state}
      actions={actions}
      disabled={disabled}
      highlighted={highlight === route.id}
      onHover={setHighlight}
    />
  ));

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col gap-3">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Route planner</h1>
          <p className="text-slate-500">
            {formatUkDate(date)}
            {date === today ? ' · today' : date === addDays(today, 1) ? ' · tomorrow' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-600">
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input mt-1 w-auto py-1.5" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Start depot
            <select value={depotId} onChange={(e) => setDepotId(e.target.value)} className="input mt-1 w-48 py-1.5">
              {state?.depots.length === 0 && <option value="">No depots</option>}
              {state?.depots.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Routes end
            <select value={endType} onChange={(e) => setEndType(e.target.value as RouteEndType)} className="input mt-1 w-40 py-1.5">
              {ROUTE_END_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ROUTE_END_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <div className="text-right">
            <button type="button" className="btn-primary" disabled={!canOptimise} onClick={optimise} title={optimiseHint}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              Optimise
            </button>
            <p className="mt-0.5 text-[11px] text-slate-500">{optimiseHint}</p>
          </div>
        </div>
      </div>

      {/* Status banners */}
      {state?.engines.optimiser === 'estimate' && (
        <p className="shrink-0 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          Using estimated travel times (straight-line distance at urban van speeds). Add Google credentials to plan with real road times – see README.
        </p>
      )}
      {running && job && (
        <p role="status" className="flex shrink-0 items-center gap-2 rounded-md bg-info/10 px-3 py-2 text-info">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {job.phase}… {Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))} s
        </p>
      )}
      {busy && !running && (
        <p role="status" className="flex shrink-0 items-center gap-2 rounded-md bg-surface px-3 py-2 text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {busy}…
        </p>
      )}
      {error && (
        <p role="alert" className="flex shrink-0 items-start justify-between gap-2 rounded-md bg-danger/10 px-3 py-2 text-danger">
          {error}
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </p>
      )}
      {job?.status === 'done' && job.result && !notice && !busy && (
        <p className="flex shrink-0 items-center justify-between gap-2 rounded-md bg-success/10 px-3 py-2 text-success">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Planned {job.result.routeIds.length} draft route{job.result.routeIds.length === 1 ? '' : 's'}. Review, adjust and release them.
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => setJob(null)}>
            <X className="h-4 w-4" />
          </button>
        </p>
      )}
      {notice && (
        <div role="alert" className="shrink-0 rounded-md bg-warning/10 px-3 py-2 text-warning">
          <p className="flex items-center justify-between font-medium">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {notice.title}
            </span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <X className="h-4 w-4" />
            </button>
          </p>
          <ul className="mt-1 list-disc pl-8 text-xs">
            {notice.items.slice(0, 10).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {notice.items.length > 10 && <li>…and {notice.items.length - 10} more</li>}
          </ul>
        </div>
      )}
      {state?.warnings
        .filter((w) => w.code === 'missing_geocode')
        .map((w) => (
          <p key={w.code} className="flex shrink-0 items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            <MapPinOff className="h-4 w-4 shrink-0" aria-hidden />
            {w.message}
          </p>
        ))}

      {plan.isError && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-danger">
          {plan.error instanceof ApiError ? plan.error.message : 'Could not load the plan.'}
        </p>
      )}
      {plan.isPending && <p className="p-6 text-center text-slate-500">Loading plan…</p>}

      {state && (
        <div className={cn('grid min-h-0 flex-1 gap-3', MAPS_KEY ? 'lg:grid-cols-[minmax(440px,5fr)_7fr]' : 'lg:grid-cols-[minmax(360px,2fr)_5fr]')}>
          <div className="min-h-0 space-y-3 overflow-y-auto pb-2 pr-1">
            <VehiclesPanel state={state} value={vehicles} onChange={setVehicles} />
            <UnassignedPanel
              orders={state.unassigned}
              routes={state.routes}
              excluded={excluded}
              disabled={disabled}
              onToggle={(id, include) =>
                setExcluded((prev) => {
                  const next = new Set(prev);
                  if (include) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onToggleAll={(include) => setExcluded(include ? new Set() : new Set(state.unassigned.map((o) => o.id)))}
              onDropFromRoute={takeOff}
              onAddToRoute={addTo}
            />
            {MAPS_KEY && routesList}
          </div>

          {MAPS_KEY ? (
            <div className="card min-h-[360px] overflow-hidden">
              <PlannerMap routes={state.routes} unassigned={state.unassigned} depot={depot} highlightRouteId={highlight} />
            </div>
          ) : (
            <div className="min-h-0 overflow-y-auto pb-2 pr-1">
              <p className="mb-3 flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-xs text-slate-500">
                <MapPinOff className="h-4 w-4 shrink-0" aria-hidden />
                Map not configured – set <code>VITE_GOOGLE_MAPS_BROWSER_KEY</code> in <code>.env</code> to see routes on a map.
              </p>
              {state.routes.length === 0 ? (
                <div className="card p-8 text-center text-slate-500">
                  No routes for {formatUkDate(date)} yet. Choose drivers and vans, then press <strong>Optimise</strong>.
                </div>
              ) : (
                <div className="grid gap-3 2xl:grid-cols-2">{routesList}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
