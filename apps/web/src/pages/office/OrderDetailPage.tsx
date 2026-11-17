import {
  FAILURE_REASON_LABELS,
  LEFT_AT_LABELS,
  ORDER_STATUS_META,
  type OrderAttempt,
  type OrderDetail,
  type OrderEventItem,
  type OrderHistory,
  formatTime,
  formatUkDate,
} from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Camera, CircleCheck, CircleX, ImageOff, MapPin, PackageMinus, Phone, Route as RouteIcon, User, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { londonDateTime } from '../../lib/format';

/** Photo links from the API last 15 minutes; refresh well before then. */
const PHOTO_REFRESH_MS = 10 * 60_000;

const OUTCOME = {
  delivered: { label: 'Delivered', icon: CircleCheck, className: 'bg-success/10 text-success' },
  partial: { label: 'Partially delivered', icon: PackageMinus, className: 'bg-warning/10 text-warning' },
  failed: { label: 'Failed', icon: CircleX, className: 'bg-danger/10 text-danger' },
} as const;

const ROLE_LABEL = { admin: 'Admin', office: 'Office', driver: 'Driver' } as const;

/** HST-01 – HST-03: everything about one order, including the driver's proof of delivery. */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  // Keys start with 'orders' so live updates (a driver completing the stop) refresh this page.
  const order = useQuery({ queryKey: ['orders', 'detail', id], queryFn: () => api<OrderDetail>(`/orders/${id}`) });
  const history = useQuery({
    queryKey: ['orders', 'history', id],
    queryFn: () => api<OrderHistory>(`/orders/${id}/history`),
    refetchInterval: PHOTO_REFRESH_MS,
  });
  const [photo, setPhoto] = useState<string | null>(null);

  const back = (
    <Link to="/office/orders" className="inline-flex items-center gap-1 text-slate-500 hover:text-ink">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Orders
    </Link>
  );

  if (order.isPending) return <p className="p-6 text-center text-slate-500">Loading order…</p>;
  if (order.isError) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-md bg-danger/10 px-4 py-3 text-danger">
          {order.error instanceof ApiError ? order.error.message : 'Could not load the order.'}
        </p>
      </div>
    );
  }
  const o = order.data;
  const h = history.data;

  return (
    <div className="space-y-5">
      <div>
        {back}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{o.orderNumber}</h1>
          <StatusBadge status={o.status} />
        </div>
        <p className="mt-0.5 text-slate-500">
          Tracking ref <span className="font-mono text-ink">{o.trackingRef}</span> · Created {londonDateTime(o.createdAt)} ·{' '}
          <span className="capitalize">{o.source}</span>
        </p>
        {o.cancelReason && <p className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-danger">Cancelled: {o.cancelReason}</p>}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left: what the driver recorded, then the full history */}
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Panel title="Delivery attempts" aside={h && h.attempts.length > 0 ? `${h.attempts.length}` : undefined}>
            {history.isPending && <p className="p-4 text-slate-500">Loading…</p>}
            {history.isError && (
              <p role="alert" className="p-4 text-danger">
                {history.error instanceof ApiError ? history.error.message : 'Could not load delivery attempts.'}
              </p>
            )}
            {h?.attempts.length === 0 && <p className="p-4 text-slate-500">No delivery attempts yet.</p>}
            {h && h.attempts.length > 0 && (
              <ul className="divide-y divide-border">
                {h.attempts.map((a) => (
                  <AttemptRow key={a.id} attempt={a} onOpenPhoto={setPhoto} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="History">
            {h?.events.length === 0 && <p className="p-4 text-slate-500">No history recorded.</p>}
            {h && h.events.length > 0 && (
              <ol className="space-y-0 p-4">
                {h.events.map((e, i) => (
                  <EventRow key={e.id} event={e} last={i === h.events.length - 1} />
                ))}
              </ol>
            )}
          </Panel>
        </div>

        {/* Right: order facts */}
        <div className="min-w-0 space-y-5">
          <Panel title="Customer">
            <dl className="space-y-2.5 p-4">
              <Fact icon={User} label="Name">
                {o.customerName}
              </Fact>
              {o.customerPhone && (
                <Fact icon={Phone} label="Phone">
                  <a href={`tel:${o.customerPhone}`} className="text-brand-primary hover:underline">
                    {o.customerPhone}
                  </a>
                  {o.customerEmail && <span className="block break-all text-slate-500">{o.customerEmail}</span>}
                </Fact>
              )}
              <Fact icon={MapPin} label="Address">
                {o.addressLine1}
                {o.addressLine2 && <>, {o.addressLine2}</>}
                <span className="block">
                  {o.town} {o.postcode}
                </span>
              </Fact>
            </dl>
          </Panel>

          <Panel title="Delivery">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
              <Detail label="Date">{o.scheduledDate ? formatUkDate(o.scheduledDate) : 'Not scheduled'}</Detail>
              <Detail label="Time window">
                {o.timeWindowStart && o.timeWindowEnd ? `${formatTime(o.timeWindowStart)}–${formatTime(o.timeWindowEnd)}` : 'Any time'}
              </Detail>
              <Detail label="Route">
                {h?.route ? (
                  <span className="inline-flex items-center gap-1">
                    <RouteIcon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                    {h.route.name}
                  </span>
                ) : (
                  '–'
                )}
              </Detail>
              <Detail label="Driver">{h?.route?.driverName ?? '–'}</Detail>
              <Detail label="Van">
                {h?.route?.vanName ?? '–'}
                {h?.route?.vanRegistration && <span className="block text-xs text-slate-500">{h.route.vanRegistration}</span>}
              </Detail>
              <Detail label="Time on site">
                {o.serviceMinutes + o.extraMinutes} min
                {o.extraReason && <span className="block text-xs text-slate-500">incl. {o.extraReason}</span>}
              </Detail>
              {o.requiresSignature && (
                <div className="col-span-2">
                  <span className="rounded bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info">Signature required</span>
                </div>
              )}
            </dl>
            {(o.accessInstructions || o.deliveryNotes || o.internalNotes) && (
              <dl className="space-y-2 border-t border-border p-4">
                {o.accessInstructions && <Detail label="Access">{o.accessInstructions}</Detail>}
                {o.deliveryNotes && <Detail label="Notes for driver">{o.deliveryNotes}</Detail>}
                {o.internalNotes && <Detail label="Internal notes">{o.internalNotes}</Detail>}
              </dl>
            )}
          </Panel>

          <Panel title="Items" aside={`${o.items.length}`}>
            {o.items.length === 0 ? (
              <p className="p-4 text-slate-500">No items.</p>
            ) : (
              <ul className="divide-y divide-border">
                {o.items.map((item) => {
                  const short = item.deliveredQty < item.qty && ['delivered', 'partially_delivered'].includes(o.status);
                  return (
                    <li key={item.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="font-medium">{item.name}</p>
                        {item.sku && <p className="text-xs text-slate-500">{item.sku}</p>}
                      </div>
                      <p className={cn('shrink-0 text-right tabular-nums', short ? 'text-warning' : 'text-slate-600')}>
                        {item.deliveredQty}/{item.qty}
                        <span className="block text-xs text-slate-500">delivered</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {photo && <PhotoViewer url={photo} onClose={() => setPhoto(null)} />}
    </div>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        {aside && <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-slate-600">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Fact({ icon: Icon, label, children }: { icon: typeof User; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0">
        <dt className="sr-only">{label}</dt>
        <dd>{children}</dd>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function AttemptRow({ attempt: a, onOpenPhoto }: { attempt: OrderAttempt; onOpenPhoto: (url: string) => void }) {
  const outcome = OUTCOME[a.outcome];
  const Icon = outcome.icon;
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium', outcome.className)}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {outcome.label}
        </span>
        <span className="text-slate-500">
          Attempt {a.attemptNo} · {londonDateTime(a.occurredAt)}
        </span>
      </div>

      <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
        <Detail label="Driver">{a.driverName ?? '–'}</Detail>
        <Detail label="Route">
          {a.routeName ?? '–'}
          {a.routeDate && <span className="block text-xs text-slate-500">{formatUkDate(a.routeDate)}</span>}
        </Detail>
        {a.outcome === 'failed' ? (
          <Detail label="Reason">{a.failureReason ? FAILURE_REASON_LABELS[a.failureReason] : '–'}</Detail>
        ) : (
          <Detail label="Received by">
            {a.recipientName ?? '–'}
            {a.leftAtType && (
              <span className="block text-xs text-slate-500">
                {LEFT_AT_LABELS[a.leftAtType]}
                {a.leftAtNote && ` · ${a.leftAtNote}`}
              </span>
            )}
          </Detail>
        )}
      </dl>

      {a.notes && <p className="rounded-md bg-surface px-3 py-2 text-slate-700">“{a.notes}”</p>}

      {a.photos.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <Camera className="h-3.5 w-3.5" aria-hidden />
            {a.photos.length} photo{a.photos.length === 1 ? '' : 's'}
          </p>
          <div className="flex flex-wrap gap-2">
            {a.photos.map((p, i) =>
              p.url ? (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenPhoto(p.url!)}
                  className="h-24 w-24 overflow-hidden rounded-md border border-border bg-surface hover:opacity-90 sm:h-28 sm:w-28"
                  aria-label={`Open photo ${i + 1} of attempt ${a.attemptNo}`}
                >
                  <img src={p.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              ) : (
                <span
                  key={p.id}
                  className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-center text-[11px] text-slate-400 sm:h-28 sm:w-28"
                >
                  <ImageOff className="h-5 w-5" aria-hidden />
                  Unavailable
                </span>
              ),
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function EventRow({ event: e, last }: { event: OrderEventItem; last: boolean }) {
  const label =
    e.type === 'created'
      ? 'Order created'
      : e.type === 'status_changed' && e.toStatus
        ? ORDER_STATUS_META[e.toStatus].label
        : e.type === 'updated'
          ? 'Details updated'
          : e.type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span className="absolute left-[5px] top-3 h-full w-px bg-border" aria-hidden />}
      <span className="relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-white bg-slate-300 ring-1 ring-slate-300" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          {label}
          {e.type === 'status_changed' && e.fromStatus && (
            <span className="font-normal text-slate-500"> (from {ORDER_STATUS_META[e.fromStatus].label})</span>
          )}
        </p>
        <p className="text-xs text-slate-500">
          {londonDateTime(e.createdAt)}
          {e.actorName ? ` · ${e.actorName}` : ' · System'}
          {e.actorRole && ` (${ROLE_LABEL[e.actorRole]})`}
        </p>
        {e.note && <p className="mt-0.5 text-slate-600">{e.note}</p>}
      </div>
    </li>
  );
}

function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4" role="dialog" aria-modal aria-label="Delivery photo" onClick={onClose}>
      <button type="button" onClick={onClose} className="absolute right-3 top-3 rounded-full bg-white/90 p-2 text-ink shadow" aria-label="Close photo">
        <X className="h-5 w-5" aria-hidden />
      </button>
      <img src={url} alt="Delivery photo" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
