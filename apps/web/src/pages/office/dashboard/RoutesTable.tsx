import type { DashboardRouteRow, RouteStatus } from '@bedex/shared';
import { ExportMenu } from '../../../components/ExportMenu';
import { cn } from '../../../lib/cn';
import { relativeTime } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';

const ROUTE_STATUS: Record<RouteStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-600' },
  released: { label: 'Released', className: 'bg-brand-primary/10 text-brand-primary' },
  in_progress: { label: 'In progress', className: 'bg-info/10 text-info' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
};

function Drift({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <span className="text-slate-400">–</span>;
  if (Math.abs(minutes) < 5) return <span className="text-success">On time</span>;
  if (minutes < 0) return <span className="text-success">{-minutes} min early</span>;
  return <span className={cn('font-medium', minutes >= 30 ? 'text-danger' : 'text-warning')}>+{minutes} min late</span>;
}

/** DSH-02. */
export function RoutesTable({ routes, isLoading }: { routes: DashboardRouteRow[] | undefined; isLoading: boolean }) {
  const now = useNow();

  return (
    <div className="overflow-x-auto">
      {/* Keep cells on one line; on narrow screens the table scrolls sideways instead of squashing. */}
      <table className="w-full whitespace-nowrap text-left">
        <thead className="border-b border-border bg-surface text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Route</th>
            <th className="px-4 py-2.5 font-medium">Driver</th>
            <th className="px-4 py-2.5 font-medium">Van</th>
            <th className="w-44 px-4 py-2.5 font-medium">Progress</th>
            <th className="px-4 py-2.5 font-medium">ETA drift</th>
            <th className="px-4 py-2.5 font-medium">Last update</th>
            <th className="px-4 py-2.5 font-medium">Manifest</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {routes?.map((r) => {
            const pct = r.stopsTotal ? Math.round((r.stopsCompleted / r.stopsTotal) * 100) : 0;
            const status = ROUTE_STATUS[r.status];
            return (
              <tr key={r.id}>
                <td className="px-4 py-2.5">
                  <p className="font-medium">{r.name}</p>
                  <span className={cn('mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium', status.className)}>
                    {status.label}
                  </span>
                </td>
                <td className="px-4 py-2.5">{r.driverName ?? <span className="text-danger">Unassigned</span>}</td>
                <td className="px-4 py-2.5">
                  {r.vanName ?? <span className="text-danger">Unassigned</span>}
                  {r.vanRegistration && <span className="block text-xs text-slate-500">{r.vanRegistration}</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-slate-100"
                      role="progressbar"
                      aria-valuenow={r.stopsCompleted}
                      aria-valuemax={r.stopsTotal}
                      aria-label={`${r.name} progress`}
                    >
                      <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-12 text-right text-xs tabular-nums text-slate-600">
                      {r.stopsCompleted}/{r.stopsTotal}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <Drift minutes={r.etaDriftMinutes} />
                </td>
                <td className="px-4 py-2.5 text-slate-600">{r.lastUpdateAt ? relativeTime(r.lastUpdateAt, now) : '–'}</td>
                <td className="px-4 py-2.5">
                  <ExportMenu size="sm" formats={['pdf', 'csv']} path={(f) => `/exports/manifest/${r.id}?format=${f}`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isLoading && <p className="p-6 text-center text-slate-500">Loading routes…</p>}
      {routes?.length === 0 && <p className="p-6 text-center text-slate-500">No routes planned for this day.</p>}
    </div>
  );
}
