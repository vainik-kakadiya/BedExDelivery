import { ROUTE_END_TYPES, ROUTE_END_TYPE_LABELS, type PlannerOrder, type PlannerRoute, type PlannerState, type RouteEndType, type RouteStatus } from '@bedex/shared';
import { AlertTriangle, ChevronDown, ChevronUp, GripVertical, RefreshCw, Send, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { type CSSProperties, type DragEvent, useState } from 'react';
import { ExportMenu } from '../../../components/ExportMenu';
import { cn } from '../../../lib/cn';
import { formatMinutes } from '../../../lib/format';
import { type DragPayload, hhmm, isOrderDrag, readDrag, startDrag } from './shared';

/** Short enough for the card's narrow select. */
const END_SHORT: Record<RouteEndType, string> = { depot: 'Ends at depot', driver_home: 'Ends at home', last_stop: 'Ends at last stop' };

const STATUS: Record<RouteStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-700' },
  released: { label: 'Released', className: 'bg-brand-primary/10 text-brand-primary' },
  in_progress: { label: 'In progress', className: 'bg-info/10 text-info' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
};

export interface RouteActions {
  setStops: (route: PlannerRoute, orderIds: string[]) => void;
  drop: (route: PlannerRoute, payload: DragPayload, index: number | null) => void;
  patch: (route: PlannerRoute, body: { driverId?: string | null; vanId?: string | null; endType?: RouteEndType }) => void;
  release: (route: PlannerRoute) => void;
  unrelease: (route: PlannerRoute) => void;
  remove: (route: PlannerRoute) => void;
  recalculate: (route: PlannerRoute) => void;
  reoptimise: (route: PlannerRoute) => void;
  /** Correct the address or drop a pin (ORD-07). */
  fixLocation: (order: PlannerOrder) => void;
}

interface Props {
  route: PlannerRoute;
  colour: string;
  state: PlannerState;
  actions: RouteActions;
  disabled: boolean;
  highlighted: boolean;
  onHover: (routeId: string | null) => void;
}

/** RTE-05 – RTE-09 for one route. */
export function RouteCard({ route, colour, state, actions, disabled, highlighted, onHover }: Props) {
  const [dropAt, setDropAt] = useState<number | 'end' | null>(null);
  const canEdit = route.editable && !disabled;
  const ids = route.stops.map((s) => s.order.id);
  const status = STATUS[route.status];
  const over = route.capacityUnits !== null && route.loadUnits > route.capacityUnits;

  const allowDrop = (e: DragEvent, at: number | 'end') => {
    if (!canEdit || !isOrderDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropAt(at);
  };
  const onDrop = (e: DragEvent, at: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropAt(null);
    const payload = readDrag(e);
    if (payload) actions.drop(route, payload, at);
  };
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    actions.setStops(route, next);
  };

  return (
    <section
      className={cn('card overflow-hidden transition-shadow', highlighted && 'ring-2 ring-offset-1')}
      style={highlighted ? ({ '--tw-ring-color': colour } as CSSProperties) : undefined}
      onMouseEnter={() => onHover(route.id)}
      onMouseLeave={() => onHover(null)}
      aria-label={route.name}
    >
      <header className="space-y-2 border-b border-border px-4 py-3" style={{ borderTop: `4px solid ${colour}` }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold">
            {route.name}
            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', status.className)}>{status.label}</span>
            {route.engine === 'estimate' && (
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning" title="Straight-line distance estimate; add Google keys for road times">
                Estimated
              </span>
            )}
          </h3>
          <div className="flex flex-wrap items-center gap-1">
            {route.status === 'draft' && (
              <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={disabled} onClick={() => actions.release(route)}>
                <Send className="h-3.5 w-3.5" aria-hidden />
                Release
              </button>
            )}
            {route.status === 'released' && (
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={disabled} onClick={() => actions.unrelease(route)}>
                <Undo2 className="h-3.5 w-3.5" aria-hidden />
                Back to draft
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <select
            aria-label={`Driver for ${route.name}`}
            value={route.driverId ?? ''}
            disabled={disabled || route.status === 'completed'}
            onChange={(e) => actions.patch(route, { driverId: e.target.value || null })}
            className="input py-1 text-xs"
          >
            <option value="">No driver</option>
            {state.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label={`Van for ${route.name}`}
            value={route.vanId ?? ''}
            disabled={disabled || route.status === 'completed'}
            onChange={(e) => actions.patch(route, { vanId: e.target.value || null })}
            className="input py-1 text-xs"
          >
            <option value="">No van</option>
            {state.vans.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.capacityUnits})
              </option>
            ))}
          </select>
          <select
            aria-label={`End of ${route.name}`}
            value={route.endType}
            disabled={!canEdit}
            onChange={(e) => actions.patch(route, { endType: e.target.value as RouteEndType })}
            className="input py-1 text-xs"
          >
            {ROUTE_END_TYPES.map((t) => (
              <option key={t} value={t} title={ROUTE_END_TYPE_LABELS[t]}>
                {END_SHORT[t]}
              </option>
            ))}
          </select>
        </div>

        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          <div>
            <dt className="sr-only">Stops</dt>
            <dd>
              <strong className="text-ink">{route.stops.length}</strong> stops
            </dd>
          </div>
          <div>
            <dt className="sr-only">Distance</dt>
            <dd>
              <strong className="text-ink">{route.totalMiles ?? '–'}</strong> mi
            </dd>
          </div>
          <div>
            <dt className="inline">Driving </dt>
            <dd className="inline font-medium text-ink">{formatMinutes(route.driveMinutes)}</dd>
          </div>
          <div>
            <dt className="inline">Total </dt>
            <dd className="inline font-medium text-ink">{formatMinutes(route.totalMinutes)}</dd>
          </div>
          <div>
            <dt className="inline">Out </dt>
            <dd className="inline font-medium text-ink">
              {hhmm(route.plannedStart)}–{hhmm(route.plannedEnd)}
            </dd>
          </div>
          <div>
            <dt className="inline">Load </dt>
            <dd className={cn('inline font-medium', over ? 'text-danger' : 'text-ink')}>
              {route.loadUnits}
              {route.capacityUnits !== null && `/${route.capacityUnits}`} units
            </dd>
          </div>
        </dl>

        {route.warnings.length > 0 && (
          <ul className="space-y-1">
            {route.warnings.map((w) => (
              <li key={w.code} className="flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {w.message}
              </li>
            ))}
          </ul>
        )}
      </header>

      <ol
        className="divide-y divide-border"
        onDragOver={(e) => allowDrop(e, 'end')}
        onDragLeave={() => setDropAt(null)}
        onDrop={(e) => onDrop(e, null)}
      >
        {route.stops.map((s, i) => {
          const late = s.etaWindowOk === false;
          return (
            <li
              key={s.id}
              draggable={canEdit}
              onDragStart={(e) => startDrag(e, { orderId: s.order.id, fromRouteId: route.id })}
              onDragOver={(e) => allowDrop(e, i)}
              onDrop={(e) => onDrop(e, i)}
              className={cn('flex items-center gap-2 px-3 py-1.5 text-sm', dropAt === i && 'shadow-[inset_0_2px_0_0_rgb(var(--brand-primary))]')}
            >
              {canEdit && <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-300" aria-hidden />}
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ background: colour }}
              >
                {s.sequence}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{s.order.orderNumber}</span> <span className="text-slate-600">{s.order.customerName}</span>
                </p>
                <p className="truncate text-xs text-slate-500">
                  {s.order.postcode} · {s.order.loadUnits} units
                  {(s.order.lat === null || s.order.geocodeStatus === 'approximate') && (
                    <button
                      type="button"
                      className={cn('ml-1 font-medium underline-offset-2 hover:underline', s.order.lat === null ? 'text-danger' : 'text-warning')}
                      title="Correct the address or drop a pin"
                      onClick={() => actions.fixLocation(s.order)}
                    >
                      {s.order.lat === null ? 'No map location – fix' : 'Approximate location – fix'}
                    </button>
                  )}
                </p>
              </div>
              <div className="text-right text-xs">
                <p className={cn('font-semibold tabular-nums', late ? 'text-danger' : 'text-ink')} title={late ? 'Outside the delivery window' : 'ETA'}>
                  {hhmm(s.eta)}
                </p>
                {s.order.timeWindowStart && (
                  <p className={cn('tabular-nums', late ? 'text-danger' : 'text-slate-500')}>
                    {s.order.timeWindowStart}–{s.order.timeWindowEnd}
                  </p>
                )}
              </div>
              {canEdit && (
                // Bigger tap targets below lg, where drag and drop isn't available on touch screens.
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    aria-label={`Move ${s.order.orderNumber} up`}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                    className="p-1 text-slate-400 hover:text-ink disabled:opacity-25 lg:p-0"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${s.order.orderNumber} down`}
                    disabled={i === route.stops.length - 1}
                    onClick={() => move(i, i + 1)}
                    className="p-1 text-slate-400 hover:text-ink disabled:opacity-25 lg:p-0"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Take ${s.order.orderNumber} off ${route.name}`}
                  onClick={() => actions.setStops(route, ids.filter((id) => id !== s.order.id))}
                  className="shrink-0 p-1.5 text-slate-400 hover:text-danger lg:p-0"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
        {canEdit && (
          <li className={cn('px-3 py-2 text-center text-xs text-slate-400', dropAt === 'end' && 'bg-brand-primary/5 text-brand-primary')}>
            {route.stops.length ? 'Drop here to add at the end' : 'Drag orders here'}
          </li>
        )}
      </ol>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {route.editable && (
            <>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={disabled || route.stops.length < 2} onClick={() => actions.reoptimise(route)}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Re-optimise
              </button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={disabled} onClick={() => actions.recalculate(route)}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Recalculate
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 text-xs hover:border-danger/40 hover:text-danger"
                disabled={disabled}
                onClick={() => actions.remove(route)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </button>
            </>
          )}
        </div>
        {/* RTE-10 */}
        <ExportMenu size="sm" label="Manifest" formats={['pdf', 'csv']} path={(f) => `/exports/manifest/${route.id}?format=${f}`} />
      </footer>
    </section>
  );
}
