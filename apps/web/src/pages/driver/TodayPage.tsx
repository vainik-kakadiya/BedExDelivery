import { formatTime } from '@bedex/shared';
import { BellRing, CheckCircle2, ChevronRight, Navigation, Phone } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError } from '../../lib/api';
import { type DriverRoute, type DriverStop, formatAddress, hhmm, isFinished, navigateUrl, useDriverToday } from '../../lib/driverRoute';

/** RTE-09: highlight office edits until the driver acknowledges them (remembered per device). */
function ChangedBanner({ route }: { route: DriverRoute }) {
  const key = `bedex.routeSeen.${route.id}`;
  const [seen, setSeen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  if (!route.changedAt || (seen && seen >= route.changedAt)) return null;
  const acknowledge = () => {
    try {
      localStorage.setItem(key, route.changedAt!);
    } catch {
      // Private mode etc.: the banner just returns next time.
    }
    setSeen(route.changedAt);
  };
  return (
    <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-info px-4 py-3 text-white">
      <span className="flex items-center gap-2 font-medium">
        <BellRing className="h-5 w-5 shrink-0" aria-hidden />
        The office changed this route at {hhmm(route.changedAt)}. Check your stops.
      </span>
      <button type="button" onClick={acknowledge} className="min-h-tap shrink-0 rounded-md bg-white/20 px-3 font-semibold">
        Got it
      </button>
    </div>
  );
}

/** A stop still to do: full details and the Navigate / Call actions. */
function StopCard({ stop }: { stop: DriverStop }) {
  const o = stop.order;
  return (
    <li className="card p-4">
      <Link
        to={`/driver/stops/${stop.id}`}
        aria-label={`Stop ${stop.sequence}, ${o.customerName}: open to complete the delivery`}
        className="-m-2 flex items-start gap-3 rounded-md p-2 active:bg-surface"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-dark font-semibold text-white">{stop.sequence}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">{o.customerName}</p>
            <StatusBadge status={o.status} />
          </div>
          <p className="text-slate-600">{formatAddress(o)}</p>
          <p className="mt-1 text-sm text-slate-500">
            {stop.eta && <>ETA {hhmm(stop.eta)}</>}
            {o.timeWindowStart && o.timeWindowEnd && (
              <>
                {stop.eta && ' · '}Window {formatTime(o.timeWindowStart)}–{formatTime(o.timeWindowEnd)}
              </>
            )}
          </p>
          {o.accessInstructions && <p className="mt-2 rounded bg-warning/10 px-2 py-1 text-sm text-warning">{o.accessInstructions}</p>}
        </div>
        <ChevronRight className="mt-1.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      </Link>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a href={navigateUrl(o)} target="_blank" rel="noreferrer" className="btn-primary min-h-tap">
          <Navigation className="h-5 w-5" aria-hidden />
          Navigate
        </a>
        {o.customerPhone ? (
          <a href={`tel:${o.customerPhone}`} className="btn-secondary min-h-tap">
            <Phone className="h-5 w-5" aria-hidden />
            Call
          </a>
        ) : (
          <span className="btn-secondary min-h-tap opacity-50">No phone</span>
        )}
      </div>
    </li>
  );
}

/** A finished stop: compact, with the outcome and when it happened. */
function DoneCard({ stop }: { stop: DriverStop }) {
  const o = stop.order;
  return (
    <li className="card flex items-start gap-3 p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
        {stop.sequence}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">{o.customerName}</p>
          <StatusBadge status={o.status} />
        </div>
        <p className="truncate text-sm text-slate-600">{formatAddress(o)}</p>
        <p className="mt-0.5 text-sm text-slate-500">
          {o.orderNumber}
          {stop.completedAt && ` · ${hhmm(stop.completedAt)}`}
        </p>
      </div>
    </li>
  );
}

/**
 * DRP-02: today's route, split across two tabs.
 * "todo" = stops still to do; "done" = finished stops (delivered, partial or failed).
 */
export function TodayPage({ view }: { view: 'todo' | 'done' }) {
  const today = useDriverToday();

  if (today.isPending) return <p className="text-slate-500">Loading today's route…</p>;
  if (today.isError) {
    return (
      <p role="alert" className="text-danger">
        {today.error instanceof ApiError ? today.error.message : "Could not load today's route."}
      </p>
    );
  }
  if (today.data.routes.length === 0) {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold">No route released for today</p>
        <p className="mt-1 text-slate-600">Check with the office if you expected one.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {today.data.routes.map((route) => {
        const done = route.stops.filter(isFinished);
        const todo = route.stops.filter((s) => !isFinished(s));
        const shown = view === 'todo' ? todo : done;
        return (
          <section key={route.id}>
            {view === 'todo' && <ChangedBanner route={route} />}
            <h1 className="mb-3 text-lg font-semibold">
              {route.name}{' '}
              <span className="font-normal text-slate-500">
                · {view === 'todo' ? `${todo.length} to go of ${route.stops.length}` : `${done.length} of ${route.stops.length} completed`}
              </span>
            </h1>

            {shown.length === 0 &&
              (view === 'todo' ? (
                <div className="card flex flex-col items-center gap-2 p-6 text-center">
                  <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
                  <p className="text-lg font-semibold">All stops completed</p>
                  <Link to="/driver/completed" className="text-brand-primary underline">
                    See completed stops
                  </Link>
                </div>
              ) : (
                <p className="card p-6 text-center text-slate-500">No stops completed yet.</p>
              ))}

            <ol className={view === 'todo' ? 'space-y-3' : 'space-y-2'}>
              {shown.map((stop) => (view === 'todo' ? <StopCard key={stop.id} stop={stop} /> : <DoneCard key={stop.id} stop={stop} />))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
