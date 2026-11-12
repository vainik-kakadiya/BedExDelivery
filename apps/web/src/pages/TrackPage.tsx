import { type PublicTracking, formatUkDate } from '@bedex/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { STATUS_ICONS, StatusBadge } from '../components/StatusBadge';
import { ApiError, api } from '../lib/api';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** TRK-01: public tracking, no login. Also reachable as /track#track-parcel from the old site. */
export function TrackPage() {
  const [params] = useSearchParams();
  const [ref, setRef] = useState(params.get('ref') ?? '');
  const [postcode, setPostcode] = useState(params.get('postcode') ?? '');
  const [submitted, setSubmitted] = useState<{ ref: string; postcode: string } | null>(() =>
    params.get('ref') && params.get('postcode') ? { ref: params.get('ref')!, postcode: params.get('postcode')! } : null,
  );

  const result = useQuery({
    queryKey: ['track', submitted],
    queryFn: () => api<PublicTracking>(`/public/track?${new URLSearchParams(submitted!)}`, { auth: false }),
    enabled: submitted !== null,
    retry: false,
    staleTime: 30_000,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted({ ref: ref.trim(), postcode: postcode.trim() });
  };

  return (
    <div className="min-h-screen">
      <header className="bg-brand-dark px-4 py-4">
        <div className="mx-auto max-w-2xl">
          <Logo inverted className="text-xl" />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10" id="track-parcel">
        <h1 className="text-2xl font-semibold">Track your delivery</h1>
        <p className="mt-1 text-slate-600">Enter the tracking number from your order confirmation and your delivery postcode.</p>

        <form onSubmit={onSubmit} className="card mt-6 grid gap-4 p-5 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <div>
            <label htmlFor="ref" className="label">
              Tracking number
            </label>
            <input id="ref" required value={ref} onChange={(e) => setRef(e.target.value)} className="input min-h-tap uppercase" autoComplete="off" />
          </div>
          <div>
            <label htmlFor="postcode" className="label">
              Postcode
            </label>
            <input
              id="postcode"
              required
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              className="input min-h-tap uppercase"
              autoComplete="postal-code"
            />
          </div>
          <button type="submit" className="btn-primary min-h-tap" disabled={result.isFetching}>
            {result.isFetching ? 'Checking…' : 'Track'}
          </button>
        </form>

        {result.isError && (
          <p role="alert" className="mt-6 rounded-md bg-danger/10 px-4 py-3 text-danger">
            {result.error instanceof ApiError ? result.error.message : 'Something went wrong. Please try again.'}
          </p>
        )}

        {result.data && <TrackingResult data={result.data} />}
      </main>
    </div>
  );
}

function TrackingResult({ data }: { data: PublicTracking }) {
  return (
    <section className="card mt-6 p-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">Tracking number</p>
          <p className="font-mono font-semibold">{data.trackingRef}</p>
        </div>
        <StatusBadge status={data.status} customer size="lg" />
      </div>

      {(data.deliveryDate || data.timeWindow) && (
        <dl className="mt-5 grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          {data.deliveryDate && (
            <div>
              <dt className="text-sm text-slate-500">Delivery date</dt>
              <dd className="font-medium">{formatUkDate(data.deliveryDate)}</dd>
            </div>
          )}
          {data.timeWindow && (
            <div>
              <dt className="text-sm text-slate-500">Time window</dt>
              <dd className="font-medium">
                {data.timeWindow.from} – {data.timeWindow.to}
              </dd>
            </div>
          )}
        </dl>
      )}

      {data.timeline.length > 0 && (
        <ol className="mt-5 space-y-4 border-t border-border pt-5">
          {[...data.timeline].reverse().map((step) => {
            const Icon = STATUS_ICONS[step.status];
            return (
              <li key={`${step.status}-${step.at}`} className="flex gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
                <div>
                  <p className="font-medium">{step.label}</p>
                  <p className="text-sm text-slate-500">{dateTime.format(new Date(step.at))}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
