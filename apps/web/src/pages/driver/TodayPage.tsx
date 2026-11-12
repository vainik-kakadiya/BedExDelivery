import { type OrderStatus, formatTime } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { Navigation, Phone } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError, api } from '../../lib/api';

interface DriverStop {
  id: string;
  sequence: number;
  eta: string | null;
  completedAt: string | null;
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    customerName: string;
    customerPhone: string | null;
    addressLine1: string;
    addressLine2: string | null;
    town: string;
    postcode: string;
    lat: number | null;
    lng: number | null;
    timeWindowStart: string | null;
    timeWindowEnd: string | null;
    accessInstructions: string | null;
    items: { id: string; name: string; qty: number }[];
  };
}

interface TodayResponse {
  date: string;
  routes: { id: string; name: string; status: string; stops: DriverStop[] }[];
}

const etaFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

function navigateUrl(o: DriverStop['order']): string {
  const destination = o.lat != null && o.lng != null ? `${o.lat},${o.lng}` : `${o.addressLine1}, ${o.town}, ${o.postcode}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** DRP-02: today's ordered stops. Stop detail + completion flow arrive in weeks 4–5. */
export function TodayPage() {
  const today = useQuery({ queryKey: ['driver', 'today'], queryFn: () => api<TodayResponse>('/driver/routes/today') });

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
      {today.data.routes.map((route) => (
        <section key={route.id}>
          <h1 className="mb-3 text-lg font-semibold">
            {route.name} <span className="font-normal text-slate-500">· {route.stops.length} stops</span>
          </h1>
          <ol className="space-y-3">
            {route.stops.map((stop) => (
              <li key={stop.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-dark font-semibold text-white">
                    {stop.sequence}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">{stop.order.customerName}</p>
                      <StatusBadge status={stop.order.status} />
                    </div>
                    <p className="text-slate-600">
                      {stop.order.addressLine1}
                      {stop.order.addressLine2 && `, ${stop.order.addressLine2}`}, {stop.order.town} {stop.order.postcode}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {stop.eta && <>ETA {etaFormat.format(new Date(stop.eta))}</>}
                      {stop.order.timeWindowStart && stop.order.timeWindowEnd && (
                        <>
                          {stop.eta && ' · '}Window {formatTime(stop.order.timeWindowStart)}–{formatTime(stop.order.timeWindowEnd)}
                        </>
                      )}
                    </p>
                    {stop.order.accessInstructions && (
                      <p className="mt-2 rounded bg-warning/10 px-2 py-1 text-sm text-warning">{stop.order.accessInstructions}</p>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <a href={navigateUrl(stop.order)} target="_blank" rel="noreferrer" className="btn-primary min-h-tap">
                    <Navigation className="h-5 w-5" aria-hidden />
                    Navigate
                  </a>
                  {stop.order.customerPhone ? (
                    <a href={`tel:${stop.order.customerPhone}`} className="btn-secondary min-h-tap">
                      <Phone className="h-5 w-5" aria-hidden />
                      Call
                    </a>
                  ) : (
                    <span className="btn-secondary min-h-tap opacity-50">No phone</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
