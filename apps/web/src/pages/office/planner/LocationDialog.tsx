import type { LatLng, PlannerOrder } from '@bedex/shared';
import { APIProvider, AdvancedMarker, Map as GoogleMap } from '@vis.gl/react-google-maps';
import { MapPin, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { MAPS_KEY } from './PlannerMap';

const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';

interface Props {
  order: PlannerOrder;
  /** Where to centre the map when the order has no location yet. */
  fallbackCentre: LatLng;
  onClose: () => void;
  onSaved: () => void;
}

/** "51.5072, -0.1276" (as Google Maps copies it) → a point. */
function parseCoordinates(text: string): LatLng | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

const problemText = (o: PlannerOrder) =>
  o.geocodeStatus === 'approximate'
    ? 'Only the postcode area was found, so the pin may be a few streets out. Drop an exact pin if you know where it is.'
    : o.geocodeStatus === 'pending'
      ? 'The address is still being looked up.'
      : o.lat === null
        ? "The map couldn't find this address, so it can't go on a route yet."
        : 'Move the pin if the delivery point is somewhere else.';

/** ORD-07: correct an address, or drop a pin where the lookup failed or was only approximate. */
export function LocationDialog({ order, fallbackCentre, onClose, onSaved }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState({ addressLine1: order.addressLine1, town: order.town, postcode: order.postcode });
  const [pin, setPin] = useState<LatLng | null>(order.lat !== null && order.lng !== null ? { lat: order.lat, lng: order.lng } : null);
  const [coordinates, setCoordinates] = useState(pin ? `${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
        setError(fields ? Object.values(fields).flat().join('. ') : err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const addressChanged =
    address.addressLine1.trim() !== order.addressLine1 || address.town.trim() !== order.town || address.postcode.trim() !== order.postcode;
  const typedPin = MAPS_KEY ? pin : parseCoordinates(coordinates);
  const pinChanged = typedPin !== null && (typedPin.lat !== order.lat || typedPin.lng !== order.lng);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="location-title"
      className="w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-white p-0 text-ink shadow-2xl backdrop:bg-slate-900/50"
    >
      <div className="space-y-4 p-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="location-title" className="flex items-center gap-2 text-base font-semibold">
              <MapPin className="h-4 w-4 text-brand-primary" aria-hidden />
              Fix location · {order.orderNumber}
            </h2>
            <p className="mt-1 text-sm text-slate-600">{problemText(order)}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-slate-500 hover:text-ink">
            <X className="h-5 w-5" />
          </button>
        </header>

        {error && (
          <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(() =>
              api(`/orders/${order.id}`, {
                method: 'PATCH',
                json: { addressLine1: address.addressLine1.trim(), town: address.town.trim(), postcode: address.postcode.trim() },
              }),
            );
          }}
        >
          <h3 className="text-sm font-medium">Correct the address</h3>
          <input
            className="input w-full"
            aria-label="Address line 1"
            value={address.addressLine1}
            onChange={(e) => setAddress({ ...address, addressLine1: e.target.value })}
          />
          <div className="flex gap-2">
            <input className="input min-w-0 flex-1" aria-label="Town" value={address.town} onChange={(e) => setAddress({ ...address, town: e.target.value })} />
            <input
              className="input w-32"
              aria-label="Postcode"
              value={address.postcode}
              onChange={(e) => setAddress({ ...address, postcode: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-secondary" disabled={busy || !addressChanged}>
              Save and look it up again
            </button>
          </div>
        </form>

        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Or drop a pin</h3>
          {MAPS_KEY ? (
            <>
              <p className="text-xs text-slate-500">Click the map where the van should stop. Drag the pin to adjust it.</p>
              <div className="h-64 overflow-hidden rounded-md border border-border">
                <APIProvider apiKey={MAPS_KEY} region="GB" language="en-GB">
                  <GoogleMap
                    mapId={MAP_ID}
                    defaultCenter={pin ?? fallbackCentre}
                    defaultZoom={pin ? 17 : 12}
                    gestureHandling="greedy"
                    clickableIcons={false}
                    className="h-full w-full"
                    onClick={(e) => {
                      const p = e.detail.latLng;
                      if (p) setPin({ lat: p.lat, lng: p.lng });
                    }}
                  >
                    {pin && (
                      <AdvancedMarker
                        position={pin}
                        draggable
                        onDragEnd={(e) => {
                          if (e.latLng) setPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
                        }}
                      />
                    )}
                  </GoogleMap>
                </APIProvider>
              </div>
            </>
          ) : (
            <>
              <label className="label" htmlFor="location-coordinates">
                Latitude, longitude
              </label>
              <input
                id="location-coordinates"
                className="input w-full"
                placeholder="51.5072, -0.1276"
                value={coordinates}
                onChange={(e) => setCoordinates(e.target.value)}
              />
              <p className="text-xs text-slate-500">In Google Maps, right-click the delivery point and click the numbers at the top to copy them.</p>
            </>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !pinChanged}
              onClick={() => typedPin && void save(() => api(`/orders/${order.id}/location`, { method: 'PUT', json: typedPin }))}
            >
              Save pin
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
