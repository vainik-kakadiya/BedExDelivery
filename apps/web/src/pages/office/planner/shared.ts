import type { DragEvent } from 'react';

/** RTE-06: shared with the live tracking map. */
export { ROUTE_COLOURS, routeColour } from '../../../lib/routeColours';

// ---------- drag and drop (RTE-07) ----------

const DND_TYPE = 'application/x-bedex-order';

export interface DragPayload {
  orderId: string;
  /** null when dragged from the unassigned list. */
  fromRouteId: string | null;
}

export function startDrag(e: DragEvent, payload: DragPayload) {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'move';
}

export const isOrderDrag = (e: DragEvent) => e.dataTransfer.types.includes(DND_TYPE);

export function readDrag(e: DragEvent): DragPayload | null {
  try {
    return JSON.parse(e.dataTransfer.getData(DND_TYPE)) as DragPayload;
  } catch {
    return null;
  }
}

/** New id list for a route after inserting `orderId` before position `index` (or at the end). */
export function insertInto(ids: string[], orderId: string, index: number | null): string[] {
  const from = ids.indexOf(orderId);
  const without = ids.filter((id) => id !== orderId);
  let at = index ?? without.length;
  if (from !== -1 && index !== null && from < index) at -= 1;
  without.splice(Math.max(0, Math.min(at, without.length)), 0, orderId);
  return without;
}

export const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
export const hhmm = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '–');
