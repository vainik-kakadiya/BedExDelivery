import { useEffect, useState } from 'react';
import { api } from './api';

export type SharingState = 'off' | 'starting' | 'on' | 'denied' | 'unavailable';

/** Send a fix at most this often while driving… */
const SEND_EVERY_MS = 30_000;
/** …or sooner once the van has moved this far. */
const SEND_AFTER_METRES = 150;
const MIN_GAP_MS = 10_000;

function metresBetween(a: GeolocationCoordinates, b: GeolocationCoordinates): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * DSH-03: while `active` (the driver has a route out today), send the phone's
 * position so the office map shows where the van is. Browsers only provide GPS
 * while the app is open on screen; when it is in the background the office sees
 * the last fix or the last completed stop instead.
 */
export function useShareLocation(active: boolean): SharingState {
  const [state, setState] = useState<SharingState>('off');

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (!('geolocation' in navigator)) {
      setState('unavailable');
      return;
    }
    setState('starting');

    let last: { at: number; coords: GeolocationCoordinates } | null = null;
    let sending = false;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setState('on');
        const now = Date.now();
        const due =
          !last ||
          now - last.at >= SEND_EVERY_MS ||
          (now - last.at >= MIN_GAP_MS && metresBetween(last.coords, pos.coords) >= SEND_AFTER_METRES);
        if (!due || sending) return;
        sending = true;
        last = { at: now, coords: pos.coords };
        api('/driver/location', {
          method: 'POST',
          json: {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
            recordedAt: new Date(pos.timestamp).toISOString(),
          },
        })
          // Offline or a blip: try again with a later fix.
          .catch(() => undefined)
          .finally(() => {
            sending = false;
          });
      },
      (err) => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [active]);

  return state;
}
