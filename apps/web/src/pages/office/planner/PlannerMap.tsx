import { type Depot, type LatLng, type PlannerOrder, type PlannerRoute, decodePolyline } from '@bedex/shared';
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { Warehouse } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { routeColour } from './shared';

export const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY;
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
const LONDON = { lat: 51.5072, lng: -0.1276 };
const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

interface Props {
  routes: PlannerRoute[];
  unassigned: PlannerOrder[];
  depot: Depot | undefined;
  highlightRouteId: string | null;
}

/** RTE-01/RTE-06: unassigned orders, and per route a coloured line with numbered pins. */
export function PlannerMap({ routes, unassigned, depot, highlightRouteId }: Props) {
  if (!MAPS_KEY) return null;
  return (
    <APIProvider apiKey={MAPS_KEY} region="GB" language="en-GB">
      <GoogleMap
        mapId={MAP_ID}
        defaultCenter={LONDON}
        defaultZoom={10}
        // On touch screens one finger scrolls the page and two move the map; otherwise the map traps scrolling.
        gestureHandling={IS_TOUCH ? 'cooperative' : 'greedy'}
        clickableIcons={false}
        className="h-full w-full"
      >
        {depot && (
          <AdvancedMarker position={depot} title={depot.name} zIndex={1}>
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-dark text-white shadow">
              <Warehouse className="h-4 w-4" aria-hidden />
            </span>
          </AdvancedMarker>
        )}
        {unassigned.flatMap((o) =>
          o.lat !== null && o.lng !== null
            ? [
                <AdvancedMarker key={o.id} position={{ lat: o.lat, lng: o.lng }} title={`Unassigned · ${o.orderNumber} · ${o.customerName}`}>
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-white bg-slate-400 shadow" />
                </AdvancedMarker>,
              ]
            : [],
        )}
        {routes.map((route, i) => {
          const colour = routeColour(i);
          const dimmed = highlightRouteId !== null && highlightRouteId !== route.id;
          return (
            <RouteLayer key={route.id} route={route} colour={colour} dimmed={dimmed} depot={depot} />
          );
        })}
        <FitBounds routes={routes} unassigned={unassigned} depot={depot} />
      </GoogleMap>
    </APIProvider>
  );
}

function RouteLayer({ route, colour, dimmed, depot }: { route: PlannerRoute; colour: string; dimmed: boolean; depot: Depot | undefined }) {
  const path = useMemo<LatLng[]>(() => {
    if (route.polyline) return decodePolyline(route.polyline);
    // Estimated timings have no road path: draw straight lines between stops.
    const stops = route.stops.flatMap((s) => (s.order.lat !== null && s.order.lng !== null ? [{ lat: s.order.lat, lng: s.order.lng }] : []));
    if (!depot || stops.length === 0) return stops;
    return [depot, ...stops, ...(route.endType === 'depot' ? [depot] : [])];
  }, [route, depot]);

  return (
    <>
      <Polyline path={path} colour={colour} opacity={dimmed ? 0.2 : 0.85} dashed={!route.polyline} />
      {route.stops.map((s) =>
        s.order.lat !== null && s.order.lng !== null ? (
          <AdvancedMarker
            key={s.id}
            position={{ lat: s.order.lat, lng: s.order.lng }}
            title={`${route.name} #${s.sequence} · ${s.order.orderNumber} · ${s.order.customerName}`}
            zIndex={dimmed ? 2 : 5}
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow"
              style={{ background: colour, opacity: dimmed ? 0.35 : 1 }}
            >
              {s.sequence}
            </span>
          </AdvancedMarker>
        ) : null,
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
      // Dashes signal "estimated straight-line path".
      icons: dashed
        ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: opacity, strokeColor: colour, scale: 3 }, offset: '0', repeat: '12px' }]
        : undefined,
    });
    return () => line.setMap(null);
  }, [map, maps, path, colour, opacity, dashed]);
  return null;
}

function FitBounds({ routes, unassigned, depot }: { routes: PlannerRoute[]; unassigned: PlannerOrder[]; depot: Depot | undefined }) {
  const map = useMap();
  const core = useMapsLibrary('core');
  const points = useMemo(() => {
    const pts: LatLng[] = [];
    if (depot) pts.push(depot);
    for (const o of [...unassigned, ...routes.flatMap((r) => r.stops.map((s) => s.order))]) {
      if (o.lat !== null && o.lng !== null) pts.push({ lat: o.lat, lng: o.lng });
    }
    return pts;
  }, [routes, unassigned, depot]);
  const fitted = useRef('');
  useEffect(() => {
    const key = `${points.length}`;
    if (!map || !core || points.length === 0 || fitted.current === key) return;
    const bounds = new core.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 48);
    fitted.current = key;
  }, [map, core, points]);
  return null;
}
