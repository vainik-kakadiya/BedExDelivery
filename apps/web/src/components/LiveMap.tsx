import { type DashboardLive, ORDER_STATUS_META, type StatusTone } from '@bedex/shared';
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { MapPinOff, Truck, Warehouse } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY;
/** Advanced markers need a map ID; Google's DEMO_MAP_ID works for development. */
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
const LONDON = { lat: 51.5072, lng: -0.1276 };

const PIN_BG: Record<StatusTone, string> = {
  neutral: 'bg-slate-500',
  brand: 'bg-brand-primary',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-slate-400',
};

/** DSH-03: drivers' last known positions and every stop pin, coloured by status. */
export function LiveMap({ data }: { data: DashboardLive | undefined }) {
  if (!API_KEY) return <MapUnavailable data={data} />;

  return (
    <APIProvider apiKey={API_KEY} region="GB" language="en-GB">
      <div className="h-[320px] overflow-hidden rounded-b-lg sm:h-[420px]">
        <GoogleMap mapId={MAP_ID} defaultCenter={LONDON} defaultZoom={10} gestureHandling="cooperative" clickableIcons={false}>
          {data?.depots.map((d) => (
            <AdvancedMarker key={d.id} position={d} title={d.name} zIndex={1}>
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-dark text-white shadow">
                <Warehouse className="h-4 w-4" aria-hidden />
              </span>
            </AdvancedMarker>
          ))}
          {data?.stops.map((s) => {
            const meta = ORDER_STATUS_META[s.status];
            return (
              <AdvancedMarker
                key={s.stopId}
                position={s}
                title={`${s.routeName} #${s.sequence} · ${s.orderNumber} · ${s.customerName} · ${meta.label}`}
                zIndex={2}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow',
                    PIN_BG[meta.tone],
                  )}
                >
                  {s.sequence}
                </span>
              </AdvancedMarker>
            );
          })}
          {data?.drivers.map((d) => (
            <AdvancedMarker key={d.driverId} position={d} title={`${d.name}${d.routeName ? ` · ${d.routeName}` : ''}`} zIndex={3}>
              <span className="flex items-center gap-1 rounded-full bg-brand-dark py-1 pl-1.5 pr-2.5 text-xs font-semibold text-white shadow-lg">
                <Truck className="h-4 w-4" aria-hidden />
                {d.name.split(' ')[0]}
              </span>
            </AdvancedMarker>
          ))}
          <FitBounds data={data} />
        </GoogleMap>
      </div>
    </APIProvider>
  );
}

/** Zoom to the day's points once, and again only when the set of points changes size. */
function FitBounds({ data }: { data: DashboardLive | undefined }) {
  const map = useMap();
  const core = useMapsLibrary('core');
  const points = useMemo(
    () => [...(data?.stops ?? []), ...(data?.drivers ?? []), ...(data?.depots ?? [])].map(({ lat, lng }) => ({ lat, lng })),
    [data],
  );
  const fittedFor = useRef(-1);
  useEffect(() => {
    if (!map || !core || points.length === 0 || fittedFor.current === points.length) return;
    const bounds = new core.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 48);
    fittedFor.current = points.length;
  }, [map, core, points]);
  return null;
}

/** Without a browser key the map can't load; still show who is where. */
function MapUnavailable({ data }: { data: DashboardLive | undefined }) {
  const now = useNow();
  const counts = new Map<string, number>();
  for (const s of data?.stops ?? []) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);

  return (
    <div className="p-4">
      <div className="flex items-start gap-3 rounded-md bg-surface p-3 text-slate-600">
        <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          Map not configured. Add <code className="font-mono text-xs">VITE_GOOGLE_MAPS_BROWSER_KEY</code> to <code>.env</code> and
          restart <code>npm run dev</code> to see drivers and stops on a map.
        </p>
      </div>
      <h3 className="mt-4 font-medium">Drivers – last known position</h3>
      {data?.drivers.length ? (
        <ul className="mt-2 divide-y divide-border">
          {data.drivers.map((d) => (
            <li key={d.driverId} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-slate-400" aria-hidden />
                <span className="font-medium">{d.name}</span>
                {d.routeName && <span className="text-slate-500">· {d.routeName}</span>}
              </span>
              <a
                className="text-brand-primary hover:underline"
                href={`https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`}
                target="_blank"
                rel="noreferrer"
              >
                {relativeTime(d.recordedAt, now)}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-slate-500">No driver locations received for this day.</p>
      )}
      {counts.size > 0 && (
        <p className="mt-3 text-slate-500">
          Stops:{' '}
          {[...counts.entries()]
            .map(([status, n]) => `${n} ${ORDER_STATUS_META[status as keyof typeof ORDER_STATUS_META].label.toLowerCase()}`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
