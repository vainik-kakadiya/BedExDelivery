import { type DashboardLive, type LatLng, type LiveRoute, decodePolyline } from '@bedex/shared';
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { Check, MapPinOff, Truck, Warehouse, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { routeColour } from '../lib/routeColours';

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY;
/** Advanced markers need a map ID; Google's DEMO_MAP_ID works for development. */
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
const LONDON = { lat: 51.5072, lng: -0.1276 };
const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
/** A GPS fix older than this is drawn faded: the van has probably moved on. */
export const STALE_FIX_MS = 10 * 60_000;

const FAILED = new Set(['failed', 'partially_delivered', 'returned_to_warehouse', 'cancelled']);

interface Props {
  data: DashboardLive | undefined;
  /** Highlight one route and dim the others. */
  selectedRouteId?: string | null;
  onSelect?: (routeId: string | null) => void;
  className?: string;
}

/**
 * DSH-03: every van of the day on one map – its route line and stops in the
 * route's colour (same as the planner), finished stops ticked, and the van where
 * it was last seen.
 */
export function LiveMap({ data, selectedRouteId = null, onSelect, className }: Props) {
  if (!API_KEY) return <MapUnavailable data={data} />;

  const routes = data?.routes ?? [];
  return (
    <APIProvider apiKey={API_KEY} region="GB" language="en-GB">
      <div className={cn('h-[320px] overflow-hidden sm:h-[420px]', className)}>
        <GoogleMap
          mapId={MAP_ID}
          defaultCenter={LONDON}
          defaultZoom={10}
          gestureHandling={IS_TOUCH ? 'cooperative' : 'greedy'}
          clickableIcons={false}
          onClick={() => onSelect?.(null)}
        >
          {data?.depots.map((d) => (
            <AdvancedMarker key={d.id} position={d} title={d.name} zIndex={1}>
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-dark text-white shadow">
                <Warehouse className="h-4 w-4" aria-hidden />
              </span>
            </AdvancedMarker>
          ))}
          {routes.map((route, i) => (
            <RouteLayer
              key={route.routeId}
              route={route}
              colour={routeColour(i)}
              dimmed={selectedRouteId !== null && selectedRouteId !== route.routeId}
              data={data!}
              onSelect={onSelect}
            />
          ))}
          <FitBounds data={data} />
          <PanToSelected data={data} selectedRouteId={selectedRouteId} />
        </GoogleMap>
      </div>
    </APIProvider>
  );
}

function RouteLayer({
  route,
  colour,
  dimmed,
  data,
  onSelect,
}: {
  route: LiveRoute;
  colour: string;
  dimmed: boolean;
  data: DashboardLive;
  onSelect?: (routeId: string) => void;
}) {
  const now = useNow();
  const stops = useMemo(() => data.stops.filter((s) => s.routeId === route.routeId), [data, route.routeId]);
  const path = useMemo<LatLng[]>(() => {
    if (route.polyline) return decodePolyline(route.polyline);
    // Estimated timings have no road path: straight lines between the stops.
    const depot = data.depots.find((d) => d.id === route.depotId);
    const points = stops.map(({ lat, lng }) => ({ lat, lng }));
    if (!depot || points.length === 0) return points;
    return [depot, ...points, ...(route.endType === 'depot' ? [depot] : [])];
  }, [route, stops, data.depots]);

  const fixAge = route.position ? now - new Date(route.position.at).getTime() : 0;
  const stale = route.position?.source === 'stop' || fixAge > STALE_FIX_MS;
  const select = () => onSelect?.(route.routeId);

  return (
    <>
      <Polyline path={path} colour={colour} opacity={dimmed ? 0.15 : 0.8} dashed={!route.polyline} />
      {stops.map((s) => {
        const finished = s.completedAt !== null || FAILED.has(s.status) || s.status === 'delivered';
        const failed = FAILED.has(s.status);
        return (
          <AdvancedMarker
            key={s.stopId}
            position={s}
            title={`${route.name} #${s.sequence} · ${s.postcode} · ${s.customerName}${finished ? (failed ? ' · not delivered' : ' · done') : ''}`}
            zIndex={dimmed ? 2 : finished ? 4 : 5}
            onClick={select}
          >
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border-2 text-[11px] font-bold shadow',
                finished ? 'bg-white' : 'border-white text-white',
              )}
              style={{
                background: finished ? undefined : colour,
                borderColor: finished ? colour : undefined,
                color: finished ? colour : undefined,
                opacity: dimmed ? 0.3 : 1,
              }}
            >
              {failed ? <X className="h-3.5 w-3.5 text-danger" aria-hidden /> : finished ? <Check className="h-3.5 w-3.5" aria-hidden /> : s.sequence}
            </span>
          </AdvancedMarker>
        );
      })}
      {route.position && (
        <AdvancedMarker
          position={route.position}
          title={`${route.driverName ?? route.name} · ${route.name} · ${route.position.source === 'gps' ? 'GPS' : 'last stop'} ${relativeTime(route.position.at, now)}`}
          zIndex={dimmed ? 3 : 10}
          onClick={select}
        >
          <span
            className="flex items-center gap-1 rounded-full border-2 border-white py-1 pl-1.5 pr-2.5 text-xs font-semibold text-white shadow-lg"
            style={{ background: colour, opacity: dimmed ? 0.4 : stale ? 0.7 : 1 }}
          >
            <Truck className="h-4 w-4" aria-hidden />
            {route.driverName?.split(' ')[0] ?? route.name}
          </span>
        </AdvancedMarker>
      )}
    </>
  );
}

function Polyline({ path, colour, opacity, dashed }: { path: LatLng[]; colour: string; opacity: number; dashed: boolean }) {
  const map = useMap();
  const maps = useMapsLibrary('maps');
  useEffect(() => {
    if (!map || !maps || path.length < 2) return;
    const line = new maps.Polyline({
      map,
      path,
      strokeColor: colour,
      strokeOpacity: dashed ? 0 : opacity,
      strokeWeight: 4,
      clickable: false,
      // Dashes signal "estimated straight-line path".
      icons: dashed
        ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: opacity, strokeColor: colour, scale: 3 }, offset: '0', repeat: '12px' }]
        : undefined,
    });
    return () => line.setMap(null);
  }, [map, maps, path, colour, opacity, dashed]);
  return null;
}

/** Zoom to the day's points once, and again only when the set of routes or stops changes. */
function FitBounds({ data }: { data: DashboardLive | undefined }) {
  const map = useMap();
  const core = useMapsLibrary('core');
  const points = useMemo(
    () =>
      [...(data?.stops ?? []), ...(data?.routes.flatMap((r) => (r.position ? [r.position] : [])) ?? []), ...(data?.depots ?? [])].map(
        ({ lat, lng }) => ({ lat, lng }),
      ),
    [data],
  );
  const key = `${data?.date}:${data?.routes.length ?? 0}:${data?.stops.length ?? 0}`;
  const fittedFor = useRef('');
  useEffect(() => {
    if (!map || !core || points.length === 0 || fittedFor.current === key) return;
    const bounds = new core.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 48);
    fittedFor.current = key;
  }, [map, core, points, key]);
  return null;
}

/** Selecting a van from the list moves the map to it. */
function PanToSelected({ data, selectedRouteId }: { data: DashboardLive | undefined; selectedRouteId: string | null }) {
  const map = useMap();
  const route = data?.routes.find((r) => r.routeId === selectedRouteId);
  const target = route?.position ?? data?.stops.find((s) => s.routeId === selectedRouteId && s.stopId === route?.nextStop?.stopId) ?? null;
  const lastPanned = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !selectedRouteId || !target || lastPanned.current === selectedRouteId) return;
    map.panTo(target);
    if ((map.getZoom() ?? 0) < 12) map.setZoom(13);
    lastPanned.current = selectedRouteId;
  }, [map, selectedRouteId, target]);
  useEffect(() => {
    if (!selectedRouteId) lastPanned.current = null;
  }, [selectedRouteId]);
  return null;
}

/** Without a browser key the map can't load; still show who is where. */
function MapUnavailable({ data }: { data: DashboardLive | undefined }) {
  const now = useNow();
  const routes = data?.routes.filter((r) => r.status !== 'draft') ?? [];

  return (
    <div className="p-4">
      <div className="flex items-start gap-3 rounded-md bg-surface p-3 text-slate-600">
        <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          Map not configured. Add <code className="font-mono text-xs">VITE_GOOGLE_MAPS_BROWSER_KEY</code> to <code>.env</code> and
          restart <code>npm run dev</code> to see vans and routes on a map.
        </p>
      </div>
      <h3 className="mt-4 font-medium">Vans – last known position</h3>
      {routes.length ? (
        <ul className="mt-2 divide-y divide-border">
          {routes.map((r, i) => (
            <li key={r.routeId} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: routeColour(i) }} aria-hidden />
                <span className="font-medium">{r.driverName ?? 'No driver'}</span>
                <span className="text-slate-500">
                  · {r.name} · {r.stopsCompleted}/{r.stopsTotal}
                </span>
              </span>
              {r.position ? (
                <a
                  className="text-brand-primary hover:underline"
                  href={`https://www.google.com/maps/search/?api=1&query=${r.position.lat},${r.position.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {relativeTime(r.position.at, now)}
                </a>
              ) : (
                <span className="text-slate-400">Not started</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-slate-500">No routes out on this day.</p>
      )}
    </div>
  );
}
