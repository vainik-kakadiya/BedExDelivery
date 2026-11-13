import { LEFT_AT_LABELS, LEFT_AT_TYPES, type LeftAtType, MAX_PROOF_PHOTOS, type StopDeliveredInput, formatTime } from '@bedex/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Camera, CheckCircle2, ChevronLeft, Loader2, Navigation, Phone, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../../components/StatusBadge';
import { ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { DRIVER_TODAY_KEY, type DriverStop, findStop, formatAddress, hhmm, isFinished, navigateUrl, useDriverToday } from '../../lib/driverRoute';
import { compressPhoto, newId } from '../../lib/photos';

interface Photo {
  id: string;
  preview: string;
  blob: Blob | null;
  takenAt: string;
  status: 'processing' | 'uploading' | 'done' | 'error';
  path?: string;
  error?: string;
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** DRP-04 stop detail + DRP-05 "Delivered" with photo proof. */
export function StopPage() {
  const { stopId = '' } = useParams();
  const today = useDriverToday();

  if (today.isPending) return <p className="text-slate-500">Loading stop…</p>;
  if (today.isError) return <p role="alert" className="text-danger">{errorText(today.error, 'Could not load this stop.')}</p>;

  const found = findStop(today.data, stopId);
  if (!found) {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold">Stop not found</p>
        <p className="mt-1 text-slate-600">It may have been moved to another route by the office.</p>
        <Link to="/driver" className="mt-3 inline-block text-brand-primary underline">
          Back to today's stops
        </Link>
      </div>
    );
  }

  const { stop } = found;
  return (
    <div className="space-y-4">
      <Link to="/driver" className="-ml-1 inline-flex min-h-tap items-center gap-1 font-medium text-brand-primary">
        <ChevronLeft className="h-5 w-5" aria-hidden />
        All stops
      </Link>
      <StopDetails stop={stop} />
      {isFinished(stop) ? (
        <div className="card flex items-center gap-3 p-4">
          <CheckCircle2 className="h-6 w-6 shrink-0 text-success" aria-hidden />
          <p className="font-medium">
            This stop is complete{stop.completedAt && ` (${hhmm(stop.completedAt)})`}.
          </p>
        </div>
      ) : (
        <DeliveredForm key={stop.id} stop={stop} />
      )}
    </div>
  );
}

function StopDetails({ stop }: { stop: DriverStop }) {
  const o = stop.order;
  return (
    <section className="card p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-dark font-semibold text-white">{stop.sequence}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">{o.customerName}</h1>
            <StatusBadge status={o.status} />
          </div>
          <p className="text-slate-600">{formatAddress(o)}</p>
          <p className="mt-1 text-sm text-slate-500">
            {o.orderNumber}
            {stop.eta && ` · ETA ${hhmm(stop.eta)}`}
            {o.timeWindowStart && o.timeWindowEnd && ` · Window ${formatTime(o.timeWindowStart)}–${formatTime(o.timeWindowEnd)}`}
          </p>
        </div>
      </div>

      {o.accessInstructions && <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-sm text-warning">{o.accessInstructions}</p>}
      {o.deliveryNotes && <p className="mt-2 rounded bg-surface px-3 py-2 text-sm text-slate-700">{o.deliveryNotes}</p>}

      {o.items.length > 0 && (
        <ul className="mt-3 divide-y divide-border border-t border-border text-sm">
          {o.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-3 py-2">
              <span>{item.name}</span>
              <span className="shrink-0 font-medium">× {item.qty}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <a href={navigateUrl(o)} target="_blank" rel="noreferrer" className="btn-secondary min-h-tap">
          <Navigation className="h-5 w-5" aria-hidden />
          Navigate
        </a>
        {o.customerPhone ? (
          <a href={`tel:${o.customerPhone}`} className="btn-secondary min-h-tap">
            <Phone className="h-5 w-5" aria-hidden />
            Call
          </a>
        ) : (
          <span className="btn-secondary min-h-tap opacity-50">No phone</span>
        )}
      </div>
    </section>
  );
}

function DeliveredForm({ stop }: { stop: DriverStop }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cameraInput = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [recipientName, setRecipientName] = useState('');
  const [leftAtType, setLeftAtType] = useState<LeftAtType>('customer');
  const [leftAtNote, setLeftAtNote] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  // One id per delivery: a retried submit is recognised by the server, never recorded twice.
  const [clientActionId] = useState(newId);

  // Free the in-memory previews when leaving the page.
  const previews = useRef<string[]>([]);
  previews.current = photos.map((p) => p.preview);
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const patch = (id: string, change: Partial<Photo>) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)));

  async function upload(id: string, blob: Blob) {
    patch(id, { status: 'uploading', error: undefined });
    try {
      const { path } = await api<{ path: string }>(`/driver/stops/${stop.id}/photos`, {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      patch(id, { status: 'done', path });
    } catch (err) {
      patch(id, { status: 'error', error: errorText(err, navigator.onLine ? 'Upload failed' : "You're offline") });
    }
  }

  async function addPhotos(files: FileList | null) {
    const room = MAX_PROOF_PHOTOS - photos.length;
    for (const file of Array.from(files ?? []).slice(0, room)) {
      const id = newId();
      const takenAt = new Date().toISOString();
      setPhotos((list) => [...list, { id, preview: URL.createObjectURL(file), blob: null, takenAt, status: 'processing' }]);
      let blob: Blob;
      try {
        blob = await compressPhoto(file);
      } catch {
        patch(id, { status: 'error', error: 'Could not read that photo' });
        continue;
      }
      patch(id, { blob });
      await upload(id, blob);
    }
  }

  function removePhoto(photo: Photo) {
    URL.revokeObjectURL(photo.preview);
    setPhotos((list) => list.filter((p) => p.id !== photo.id));
  }

  const uploaded = photos.filter((p) => p.status === 'done' && p.path);
  const busy = photos.some((p) => p.status === 'processing' || p.status === 'uploading');
  const needsNote = leftAtType !== 'customer';
  const problems = {
    photos: uploaded.length === 0 ? 'Take at least one photo of the delivered items' : null,
    recipientName: recipientName.trim() ? null : 'Enter who took the delivery',
    leftAtNote: needsNote && !leftAtNote.trim() ? (leftAtType === 'neighbour' ? "Enter the neighbour's door number" : 'Describe the safe place') : null,
  };
  const valid = !problems.photos && !problems.recipientName && !problems.leftAtNote;

  const complete = useMutation({
    mutationFn: (input: StopDeliveredInput) => api<{ attemptId: string }>(`/driver/stops/${stop.id}/complete`, { method: 'POST', json: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: DRIVER_TODAY_KEY });
      navigate('/driver', { replace: true });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setShowErrors(true);
    if (!valid || busy) return;
    complete.mutate({
      outcome: 'delivered',
      recipientName: recipientName.trim(),
      leftAtType,
      leftAtNote: needsNote ? leftAtNote.trim() : null,
      notes: notes.trim() || null,
      photos: uploaded.map((p) => ({ path: p.path!, takenAt: p.takenAt })),
      clientActionId,
      occurredAt: new Date().toISOString(),
    });
  }

  const fieldError = (msg: string | null) => showErrors && msg && <p className="mt-1 text-sm text-danger">{msg}</p>;

  return (
    <form onSubmit={submit} noValidate className="card space-y-5 p-4">
      <h2 className="text-lg font-semibold">Complete delivery</h2>

      <fieldset>
        <legend className="label">
          Proof photos <span className="font-normal text-slate-500">(at least 1)</span>
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="relative aspect-square overflow-hidden rounded-md border border-border bg-surface">
              <img src={photo.preview} alt="Delivery proof" className={cn('h-full w-full object-cover', photo.status !== 'done' && 'opacity-60')} />
              {(photo.status === 'processing' || photo.status === 'uploading') && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-7 w-7 animate-spin text-white drop-shadow" aria-label="Uploading" />
                </span>
              )}
              {photo.status === 'done' && (
                <CheckCircle2 className="absolute bottom-1 left-1 h-5 w-5 rounded-full bg-white text-success" aria-label="Uploaded" />
              )}
              {photo.status === 'error' && (
                <button
                  type="button"
                  disabled={!photo.blob}
                  onClick={() => photo.blob && void upload(photo.id, photo.blob)}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-danger/70 p-1 text-center text-xs font-semibold text-white"
                >
                  {photo.blob ? <RotateCw className="h-5 w-5" aria-hidden /> : <AlertCircle className="h-5 w-5" aria-hidden />}
                  {photo.blob ? `${photo.error} · Retry` : photo.error}
                </button>
              )}
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => removePhoto(photo)}
                className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
          {photos.length < MAX_PROOF_PHOTOS && (
            <button
              type="button"
              onClick={() => cameraInput.current?.click()}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-brand-primary/50 text-sm font-medium text-brand-primary active:bg-brand-primary/5"
            >
              <Camera className="h-7 w-7" aria-hidden />
              {photos.length === 0 ? 'Take photo' : 'Add another'}
            </button>
          )}
        </div>
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => {
            void addPhotos(e.target.files);
            e.target.value = '';
          }}
        />
        {fieldError(problems.photos)}
      </fieldset>

      <div>
        <label htmlFor="recipient" className="label">
          Received by
        </label>
        <input
          id="recipient"
          className="input min-h-tap"
          autoComplete="off"
          placeholder="Name of the person who took it"
          value={recipientName}
          onChange={(e) => setRecipientName(e.target.value)}
        />
        {fieldError(problems.recipientName)}
      </div>

      <fieldset>
        <legend className="label">Left with</legend>
        <div className="grid gap-2">
          {LEFT_AT_TYPES.map((type) => (
            <label
              key={type}
              className={cn(
                'flex min-h-tap cursor-pointer items-center gap-3 rounded-md border px-3',
                leftAtType === type ? 'border-brand-primary bg-brand-primary/5 font-medium' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="leftAt"
                value={type}
                checked={leftAtType === type}
                onChange={() => setLeftAtType(type)}
                className="h-5 w-5 accent-brand-primary"
              />
              {LEFT_AT_LABELS[type]}
            </label>
          ))}
        </div>
        {needsNote && (
          <div className="mt-2">
            <input
              aria-label={leftAtType === 'neighbour' ? "Neighbour's door number" : 'Safe place description'}
              className="input min-h-tap"
              placeholder={leftAtType === 'neighbour' ? 'Door number, e.g. No. 14' : 'Where, e.g. behind the side gate'}
              value={leftAtNote}
              onChange={(e) => setLeftAtNote(e.target.value)}
            />
            {fieldError(problems.leftAtNote)}
          </div>
        )}
      </fieldset>

      <div>
        <label htmlFor="notes" className="label">
          Notes <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea id="notes" rows={2} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {complete.isError && (
        <p role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-danger">
          {errorText(complete.error, 'Could not complete the delivery. Try again.')}
        </p>
      )}

      <button type="submit" disabled={complete.isPending || busy} className="btn-primary min-h-tap w-full text-base">
        {complete.isPending ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-5 w-5" aria-hidden />}
        {busy ? 'Uploading photos…' : 'Confirm delivered'}
      </button>
    </form>
  );
}
