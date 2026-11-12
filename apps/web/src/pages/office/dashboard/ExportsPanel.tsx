import { ATTEMPT_OUTCOMES, type DriverOption } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExportButtons } from '../../../components/ExportButtons';
import { api } from '../../../lib/api';

const OUTCOME_LABELS = { delivered: 'Delivered', partial: 'Partially delivered', failed: 'Failed' } as const;

/** DSH-06: delivery report by date range, driver and outcome. */
export function ExportsPanel({ date }: { date: string }) {
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [driverId, setDriverId] = useState('');
  const [outcome, setOutcome] = useState('');
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => api<DriverOption[]>('/drivers'), staleTime: 5 * 60_000 });

  const params = new URLSearchParams({ from, to });
  if (driverId) params.set('driverId', driverId);
  if (outcome) params.set('outcome', outcome);

  return (
    <div className="space-y-5 p-4">
      <div>
        <h3 className="font-medium">Delivery report</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-medium text-slate-600">
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="input mt-1 py-1.5" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="input mt-1 py-1.5" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Driver
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className="input mt-1 py-1.5">
              <option value="">All drivers</option>
              {drivers.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {!d.active && ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Outcome
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="input mt-1 py-1.5">
              <option value="">All outcomes</option>
              {ATTEMPT_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExportButtons className="mt-3" path={(f) => `/exports/deliveries?${params}&format=${f}`} />
      </div>

      <div className="border-t border-border pt-4 text-slate-600">
        <p>
          <span className="font-medium text-ink">Order list:</span> export from the{' '}
          <Link to="/office/orders" className="text-brand-primary hover:underline">
            Orders page
          </Link>{' '}
          using its search and filters.
        </p>
        <p className="mt-1">
          <span className="font-medium text-ink">Route manifests:</span> use the PDF / CSV buttons in the routes table above.
        </p>
      </div>
    </div>
  );
}
