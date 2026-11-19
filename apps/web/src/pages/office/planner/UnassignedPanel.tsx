import type { PlannerOrder, PlannerRoute } from '@bedex/shared';
import { GripVertical, Inbox, Loader2, MapPin, MapPinOff } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '../../../components/StatusBadge';
import { cn } from '../../../lib/cn';
import { type DragPayload, isOrderDrag, readDrag, startDrag } from './shared';

interface Props {
  orders: PlannerOrder[];
  routes: PlannerRoute[];
  excluded: Set<string>;
  onToggle: (orderId: string, include: boolean) => void;
  onToggleAll: (include: boolean) => void;
  /** Drop target: take an order off its route. */
  onDropFromRoute: (payload: DragPayload) => void;
  onAddToRoute: (orderId: string, routeId: string) => void;
  disabled: boolean;
  /** Whether the API is looking up addresses (needs GOOGLE_MAPS_SERVER_KEY). */
  geocoding: boolean;
  /** Correct the address or drop a pin (ORD-07). */
  onFixLocation: (order: PlannerOrder) => void;
}

/** RTE-01: eligible orders not yet on a route. Ticked ones go into the next optimisation. */
export function UnassignedPanel({ orders, routes, excluded, onToggle, onToggleAll, onDropFromRoute, onAddToRoute, disabled, geocoding, onFixLocation }: Props) {
  const [over, setOver] = useState(false);
  const editable = routes.filter((r) => r.editable);
  const plannable = orders.filter((o) => o.lat !== null && o.lng !== null);
  const included = plannable.filter((o) => !excluded.has(o.id)).length;
  const units = plannable.filter((o) => !excluded.has(o.id)).reduce((n, o) => n + o.loadUnits, 0);

  return (
    <section
      className={cn('card transition-colors', over && 'border-brand-primary bg-brand-primary/5')}
      onDragOver={(e) => {
        if (disabled || !isOrderDrag(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const payload = readDrag(e);
        if (payload?.fromRouteId) onDropFromRoute(payload);
      }}
      aria-label="Unassigned orders"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Inbox className="h-4 w-4 text-slate-500" aria-hidden />
          Unassigned orders
          <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-slate-600">{orders.length}</span>
        </h2>
        {plannable.length > 0 && (
          <span className="flex items-center gap-2 text-xs text-slate-500">
            {included} to plan · {units} units
            <button type="button" className="text-brand-primary hover:underline" onClick={() => onToggleAll(included < plannable.length)}>
              {included < plannable.length ? 'Select all' : 'Select none'}
            </button>
          </span>
        )}
      </header>

      {orders.length === 0 ? (
        <p className="px-4 py-5 text-center text-slate-500">
          {over ? 'Drop to take it off the route' : 'Every eligible order is on a route.'}
        </p>
      ) : (
        <ul className="max-h-[55vh] divide-y divide-border overflow-y-auto">
          {orders.map((o) => {
            const located = o.lat !== null && o.lng !== null;
            return (
              <li
                key={o.id}
                // A stop needs a map location (RTE-08): fix it first.
                draggable={!disabled && located}
                onDragStart={(e) => startDrag(e, { orderId: o.id, fromRouteId: null })}
                className="flex items-center gap-2 px-3 py-2"
              >
                <input
                  type="checkbox"
                  aria-label={`Include ${o.orderNumber} in optimisation`}
                  checked={located && !excluded.has(o.id)}
                  disabled={!located}
                  onChange={(e) => onToggle(o.id, e.target.checked)}
                  className="h-4 w-4 rounded border-border text-brand-primary disabled:opacity-40"
                />
                <GripVertical className={cn('h-4 w-4 shrink-0 text-slate-300', located ? 'cursor-grab' : 'opacity-0')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className="font-medium">{o.orderNumber}</span>
                    <span className="truncate text-slate-600">{o.customerName}</span>
                    {o.status !== 'awaiting_scheduling' && <StatusBadge status={o.status} />}
                  </p>
                  <p className="text-xs text-slate-500">
                    {o.postcode}
                    {o.timeWindowStart && ` · ${o.timeWindowStart}–${o.timeWindowEnd}`} · {o.loadUnits} units · {o.serviceMinutes} min
                    {!located &&
                      (!geocoding ? (
                        <span className="ml-1 inline-flex items-center gap-1 font-medium text-danger" title="Set GOOGLE_MAPS_SERVER_KEY so addresses can be found on the map">
                          <MapPinOff className="h-3 w-3" aria-hidden />
                          No map location – address lookup not set up
                        </span>
                      ) : o.geocodeStatus === 'pending' ? (
                        <span className="ml-1 inline-flex items-center gap-1 font-medium text-slate-500" title="The address is being looked up on the map">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                          Finding location…
                        </span>
                      ) : (
                        <span className="ml-1 inline-flex items-center gap-1 font-medium text-danger" title="The map couldn't find this address. Check the address and postcode on the order.">
                          <MapPinOff className="h-3 w-3" aria-hidden />
                          Address not found
                        </span>
                      ))}
                    {o.geocodeStatus === 'approximate' && (
                      <span className="ml-1 inline-flex items-center gap-1 font-medium text-warning" title="Only the postcode area was found">
                        <MapPin className="h-3 w-3" aria-hidden />
                        Approximate location
                      </span>
                    )}
                  </p>
                </div>
                {(!located || o.geocodeStatus === 'approximate') && (o.geocodeStatus !== 'pending' || !geocoding) && (
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={disabled} onClick={() => onFixLocation(o)}>
                    Fix location
                  </button>
                )}
                {editable.length > 0 && located && (
                  <select
                    aria-label={`Add ${o.orderNumber} to a route`}
                    value=""
                    disabled={disabled}
                    onChange={(e) => e.target.value && onAddToRoute(o.id, e.target.value)}
                    className="input w-28 py-1 text-xs"
                  >
                    <option value="">Add to…</option>
                    {editable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
