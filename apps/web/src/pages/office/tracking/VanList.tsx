import type { LiveRoute, RouteStatus } from '@bedex/shared';
import { Flag, LocateFixed, type LucideIcon, Navigation2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { STALE_FIX_MS } from '../../../components/LiveMap';
import { cn } from '../../../lib/cn';
import { londonTime, relativeTime } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import { routeColour } from '../../../lib/routeColours';

const ROUTE_STATUS: Record<RouteStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-600' },
  released: { label: 'Not started', className: 'bg-brand-primary/10 text-brand-primary' },
  in_progress: { label: 'On the road', className: 'bg-info/10 text-info' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
};

const NOT_DELIVERED = new Set(['failed', 'partially_delivered', 'returned_to_warehouse', 'cancelled']);
const time = (iso: string | null) => (iso ? londonTime(iso) : '–');

interface Props {
  routes: LiveRoute[];
  selectedRouteId: string | null;
  onSelect: (routeId: string | null) => void;
}

/** DSH-03: one card per van – where it is, what's next, when it finishes, and the postcodes done. */
export function VanList({ routes, selectedRouteId, onSelect }: Props) {
  if (routes.length === 0) return <p className="p-4 text-slate-500">No routes on this day.</p>;
  return (
    <ul className="divide-y divide-border">
      {routes.map((r, i) => (
        <VanCard
          key={r.routeId}
          route={r}
          colour={routeColour(i)}
          selected={selectedRouteId === r.routeId}
          onSelect={() => onSelect(selectedRouteId === r.routeId ? null : r.routeId)}
        />
      ))}
    </ul>
  );
}

function VanCard({ route: r, colour, selected, onSelect }: { route: LiveRoute; colour: string; selected: boolean; onSelect: () => void }) {
  const now = useNow();
  const status = ROUTE_STATUS[r.status];
  const pct = r.stopsTotal ? Math.round((r.stopsCompleted / r.stopsTotal) * 100) : 0;
  const lateNext = r.nextStop?.eta && new Date(r.nextStop.eta).getTime() < now;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn('block w-full border-l-4 px-4 py-3 text-left hover:bg-surface', selected ? 'bg-surface' : 'border-l-transparent')}
        style={selected ? { borderLeftColor: colour } : undefined}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colour }} aria-hidden />
              <span className="truncate">{r.driverName ?? 'No driver'}</span>
            </p>
            <p className="truncate text-sm text-slate-500">
              {r.name}
              {r.vanName && ` · ${r.vanName}`}
              {r.vanRegistration && ` (${r.vanRegistration})`}
            </p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', status.className)}>{status.label}</span>
        </div>

        <div className="mt-2 flex items-center gap-2 text-sm">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
          </div>
          <span className="tabular-nums text-slate-600">
            {r.stopsCompleted}/{r.stopsTotal} stops
          </span>
        </div>

        <dl className="mt-2 space-y-1 text-sm">
          <Row icon={LocateFixed} label="Position">
            <Position route={r} now={now} />
          </Row>
          {r.nextStop && (
            <Row icon={Navigation2} label="Next">
              #{r.nextStop.sequence} {r.nextStop.postcode}
              <span className={cn(lateNext ? 'font-medium text-warning' : 'text-slate-500')}> · ETA {time(r.nextStop.eta)}</span>
            </Row>
          )}
          {r.stopsTotal > 0 && (
            <Row icon={Flag} label={r.nextStop ? 'Last stop' : 'Finished'}>
              {r.nextStop ? `ETA ${time(r.lastStopEta)}` : time(r.lastStopEta)}
              {r.plannedEnd && r.nextStop && <span className="text-slate-500"> · back {time(r.plannedEnd)}</span>}
            </Row>
          )}
        </dl>

        {r.done.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Postcodes done</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {r.done.map((d) => {
                const missed = NOT_DELIVERED.has(d.status);
                return (
                  <li
                    key={d.stopId}
                    title={`#${d.sequence}${d.completedAt ? ` at ${time(d.completedAt)}` : ''}${missed ? ' – not delivered' : ''}`}
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-xs',
                      missed ? 'bg-danger/10 text-danger line-through' : 'bg-success/10 text-success',
                    )}
                  >
                    {d.postcode}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </button>
    </li>
  );
}

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      <dt className="sr-only">{label}</dt>
      <dd className="min-w-0">
        <span className="text-slate-500">{label}: </span>
        {children}
      </dd>
    </div>
  );
}

function Position({ route: r, now }: { route: LiveRoute; now: number }) {
  if (!r.position) return <span className="text-slate-500">{r.status === 'draft' ? 'Not released' : 'Not started yet'}</span>;
  if (r.position.source === 'stop') {
    const last = r.done.at(-1);
    return (
      <span>
        at stop #{last?.sequence} {last?.postcode} <span className="text-slate-500">· {relativeTime(r.position.at, now)} (no live GPS)</span>
      </span>
    );
  }
  const stale = now - new Date(r.position.at).getTime() > STALE_FIX_MS;
  return (
    <span className={cn(stale && 'text-warning')}>
      GPS {relativeTime(r.position.at, now)}
      {r.position.accuracy !== null && r.position.accuracy > 200 && <span className="text-slate-500"> (±{r.position.accuracy} m)</span>}
    </span>
  );
}
