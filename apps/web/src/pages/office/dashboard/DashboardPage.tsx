import { type DashboardLive, type DashboardSummary, formatUkDate, toLondonDate } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LiveMap } from '../../../components/LiveMap';
import { ApiError, api } from '../../../lib/api';
import { FALLBACK_POLL_MS, useLiveStatus } from '../../../lib/live';
import { ActionQueue } from './ActionQueue';
import { ExportsPanel } from './ExportsPanel';
import { RoutesTable } from './RoutesTable';
import { SummaryCards } from './SummaryCards';

function Panel({ id, title, aside, children }: { id?: string; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card scroll-mt-6">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** DSH-01 – DSH-07. */
export function DashboardPage() {
  const today = toLondonDate();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || today;
  const isToday = date === today;
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  // Realtime pushes invalidate these; poll only if the stream is down (DSH-07).
  const live = useLiveStatus((s) => s.status);
  const refetchInterval = live === 'live' ? false : FALLBACK_POLL_MS;

  const summary = useQuery({
    queryKey: ['dashboard', 'summary', date],
    queryFn: () => api<DashboardSummary>(`/dashboard/summary?date=${date}`),
    refetchInterval,
  });
  const liveData = useQuery({
    queryKey: ['dashboard', 'live', date],
    queryFn: () => api<DashboardLive>(`/dashboard/live?date=${date}`),
    refetchInterval,
  });

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (q) navigate(`/office/orders?q=${encodeURIComponent(q)}`);
  };

  const setDate = (value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== today) next.set('date', value);
    else next.delete('date');
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-slate-500">{isToday ? `Today · ${formatUkDate(date)}` : formatUkDate(date)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* DSH-05: global search → Orders page with full filters */}
          <form onSubmit={onSearch} className="relative" role="search">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search orders, refs, postcodes…"
              aria-label="Search all orders"
              className="input w-72 pl-9"
            />
          </form>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Dashboard date" className="input w-auto" />
          {!isToday && (
            <button type="button" className="btn-secondary" onClick={() => setDate(today)}>
              Today
            </button>
          )}
        </div>
      </div>

      {summary.isError && (
        <p role="alert" className="rounded-md bg-danger/10 px-4 py-3 text-danger">
          {summary.error instanceof ApiError ? summary.error.message : 'Could not load the dashboard.'}
        </p>
      )}

      <SummaryCards cards={summary.data?.cards} date={date} isToday={isToday} />

      <div className="grid gap-5 2xl:grid-cols-5">
        <div className="2xl:col-span-3">
          <Panel id="routes" title={isToday ? "Today's routes" : 'Routes'}>
            <RoutesTable routes={summary.data?.routes} isLoading={summary.isPending} />
          </Panel>
        </div>
        <div className="2xl:col-span-2">
          <Panel
            title="Live map"
            aside={
              liveData.data && (
                <span className="text-xs text-slate-500">
                  {liveData.data.drivers.length} drivers · {liveData.data.stops.length} stops
                </span>
              )
            }
          >
            <LiveMap data={liveData.data} />
          </Panel>
        </div>
      </div>

      <Panel
        id="action-queue"
        title={
          <>
            Action queue
            {!!summary.data?.actionQueue.length && (
              <span className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                {summary.data.actionQueue.length}
              </span>
            )}
          </>
        }
        aside={<span className="text-xs text-slate-500">Failed and partial deliveries needing a decision</span>}
      >
        <ActionQueue items={summary.data?.actionQueue} isLoading={summary.isPending} />
      </Panel>

      <Panel title="Exports">
        <ExportsPanel key={date} date={date} />
      </Panel>
    </div>
  );
}
