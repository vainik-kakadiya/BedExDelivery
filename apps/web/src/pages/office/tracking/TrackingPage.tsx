import { type DashboardLive, formatUkDate, toLondonDate } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LiveMap } from '../../../components/LiveMap';
import { ApiError, api } from '../../../lib/api';
import { FALLBACK_POLL_MS, useLiveStatus } from '../../../lib/live';
import { VanList } from './VanList';

/** DSH-03: every van on one map, with progress, ETAs and postcodes done alongside. */
export function TrackingPage() {
  const today = toLondonDate();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || today;
  const [selected, setSelected] = useState<string | null>(null);

  // Driver GPS and deliveries are pushed over the live stream; poll only if it is down.
  const live = useLiveStatus((s) => s.status);
  const query = useQuery({
    queryKey: ['dashboard', 'live', date],
    queryFn: () => api<DashboardLive>(`/dashboard/live?date=${date}`),
    refetchInterval: live === 'live' ? false : FALLBACK_POLL_MS,
  });
  const routes = query.data?.routes ?? [];
  const out = routes.filter((r) => r.status === 'in_progress').length;
  const done = routes.reduce((n, r) => n + r.stopsCompleted, 0);
  const total = routes.reduce((n, r) => n + r.stopsTotal, 0);

  const setDate = (value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== today) next.set('date', value);
    else next.delete('date');
    setParams(next, { replace: true });
    setSelected(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Live tracking</h1>
          <p className="text-slate-500">
            {date === today ? `Today · ${formatUkDate(date)}` : formatUkDate(date)}
            {routes.length > 0 && ` · ${routes.length} vans, ${out} on the road · ${done}/${total} stops done`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Tracking date" className="input w-auto" />
          {date !== today && (
            <button type="button" className="btn-secondary" onClick={() => setDate(today)}>
              Today
            </button>
          )}
        </div>
      </div>

      {query.isError && (
        <p role="alert" className="rounded-md bg-danger/10 px-4 py-3 text-danger">
          {query.error instanceof ApiError ? query.error.message : 'Could not load the tracking map.'}
        </p>
      )}

      <div className="card overflow-hidden lg:grid lg:h-[calc(100dvh-10rem)] lg:grid-cols-[minmax(0,1fr)_22rem]">
        <LiveMap
          data={query.data}
          selectedRouteId={selected}
          onSelect={setSelected}
          className="h-[55vh] sm:h-[55vh] lg:h-full"
        />
        <aside className="border-t border-border lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label="Vans">
          {query.isPending ? <p className="p-4 text-slate-500">Loading…</p> : <VanList routes={routes} selectedRouteId={selected} onSelect={setSelected} />}
        </aside>
      </div>
      <p className="text-xs text-slate-500">
        Vans move when the driver app is open and sends GPS (about every 30 s). When it's in the background, the van is shown at its
        last completed stop.
      </p>
    </div>
  );
}
