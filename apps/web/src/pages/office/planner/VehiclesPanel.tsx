import type { PlannerState } from '@bedex/shared';
import { Truck } from 'lucide-react';

export type VehicleChoice = Record<string, { on: boolean; vanId: string }>;

interface Props {
  state: PlannerState;
  value: VehicleChoice;
  onChange: (next: VehicleChoice) => void;
}

/** RTE-03: which drivers work this day, and in which van. */
export function VehiclesPanel({ state, value, onChange }: Props) {
  const busyVans = new Set(state.routes.filter((r) => r.status !== 'draft' && r.vanId).map((r) => r.vanId));
  const busyDrivers = new Set(state.drivers.filter((d) => d.busyRouteNames.length > 0).map((d) => d.id));
  const chosen = Object.entries(value)
    .filter(([id, v]) => v.on && !busyDrivers.has(id) && !busyVans.has(v.vanId))
    .map(([, v]) => v);
  const vanCounts = new Map<string, number>();
  for (const v of chosen) vanCounts.set(v.vanId, (vanCounts.get(v.vanId) ?? 0) + 1);
  const set = (driverId: string, patch: Partial<VehicleChoice[string]>) =>
    onChange({ ...value, [driverId]: { ...(value[driverId] ?? { on: false, vanId: '' }), ...patch } });

  return (
    <section className="card">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Truck className="h-4 w-4 text-slate-500" aria-hidden />
          Drivers &amp; vans
        </h2>
        <span className="text-xs text-slate-500">{chosen.length} selected</span>
      </header>
      {state.drivers.length === 0 ? (
        <p className="p-4 text-slate-500">No active drivers yet. Add drivers before planning routes.</p>
      ) : (
        <ul className="divide-y divide-border">
          {state.drivers.map((d) => {
            const v = value[d.id] ?? { on: false, vanId: '' };
            const clash = v.on && v.vanId && (vanCounts.get(v.vanId) ?? 0) > 1;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={v.on}
                    onChange={(e) => set(d.id, { on: e.target.checked })}
                    className="h-4 w-4 shrink-0 rounded border-border text-brand-primary"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.name}</span>
                    <span className="block text-xs text-slate-500">
                      {d.workStart}–{d.workEnd} · max {d.maxHours} h
                    </span>
                  </span>
                </label>
                <select
                  aria-label={`Van for ${d.name}`}
                  value={v.vanId}
                  onChange={(e) => set(d.id, { vanId: e.target.value, on: Boolean(e.target.value) })}
                  className={`input w-36 shrink-0 py-1 text-xs ${clash ? 'border-danger' : ''}`}
                >
                  <option value="">No van</option>
                  {state.vans.map((van) => (
                    <option key={van.id} value={van.id}>
                      {van.name} · {van.capacityUnits} units
                    </option>
                  ))}
                </select>
                {d.busyRouteNames.length > 0 && (
                  <p className="w-full text-xs text-warning">
                    Already on {d.busyRouteNames.join(', ')} this day – not included when optimising
                  </p>
                )}
                {d.busyRouteNames.length === 0 && v.on && busyVans.has(v.vanId) && (
                  <p className="w-full text-xs text-warning">This van is on a released route this day – choose another</p>
                )}
                {clash && <p className="w-full text-xs text-danger">This van is chosen for another driver</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
