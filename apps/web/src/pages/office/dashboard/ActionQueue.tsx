import { type ActionQueueItem, FAILURE_REASON_LABELS, type OrderStatusChangeInput, toLondonDate } from '@bedex/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, Undo2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { StatusBadge } from '../../../components/StatusBadge';
import { ApiError, api } from '../../../lib/api';
import { addDays, londonDateTime } from '../../../lib/format';

type Mode = 'reschedule' | 'return' | 'cancel' | null;

/** DSH-04. */
export function ActionQueue({ items, isLoading }: { items: ActionQueueItem[] | undefined; isLoading: boolean }) {
  if (isLoading) return <p className="p-6 text-center text-slate-500">Loading…</p>;
  if (!items?.length) {
    return (
      <p className="flex items-center justify-center gap-2 p-6 text-slate-500">
        <CircleCheck className="h-4 w-4 text-success" aria-hidden />
        Nothing waiting for a decision.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <QueueRow key={item.orderId} item={item} />
      ))}
    </ul>
  );
}

function QueueRow({ item }: { item: ActionQueueItem }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(null);
  const today = toLondonDate();
  const [date, setDate] = useState(addDays(today, 1));
  const [reason, setReason] = useState('');

  const change = useMutation({
    mutationFn: (body: OrderStatusChangeInput) => api(`/orders/${item.orderId}/status`, { method: 'POST', json: body }),
    onSuccess: () => {
      setMode(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'reschedule') change.mutate({ to: 'rescheduled', scheduledDate: date });
    if (mode === 'return') change.mutate({ to: 'returned_to_warehouse' });
    if (mode === 'cancel') change.mutate({ to: 'cancelled', reason: reason.trim() });
  };

  const open = (m: Mode) => {
    change.reset();
    setMode(mode === m ? null : m);
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{item.orderNumber}</span>
            <StatusBadge status={item.status} />
          </div>
          <p className="text-slate-600">
            {item.customerName} · {item.town} {item.postcode}
          </p>
          {item.attemptAt && (
            <p className="mt-0.5 text-xs text-slate-500">
              Attempt {item.attemptNo}
              {item.failureReason && <> · {FAILURE_REASON_LABELS[item.failureReason]}</>}
              {item.driverName && <> · {item.driverName}</>} · {londonDateTime(item.attemptAt)}
            </p>
          )}
          {item.attemptNotes && <p className="mt-0.5 text-xs italic text-slate-500">“{item.attemptNotes}”</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" aria-expanded={mode === 'reschedule'} onClick={() => open('reschedule')}>
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            Reschedule
          </button>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" aria-expanded={mode === 'return'} onClick={() => open('return')}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            Return to warehouse
          </button>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs hover:border-danger/40 hover:text-danger"
            aria-expanded={mode === 'cancel'}
            onClick={() => open('cancel')}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Cancel
          </button>
        </div>
      </div>

      {mode && (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-surface p-3">
          {mode === 'reschedule' && (
            <label className="text-xs font-medium text-slate-600">
              New delivery date
              <input type="date" required min={today} value={date} onChange={(e) => setDate(e.target.value)} className="input mt-1 py-1.5" />
            </label>
          )}
          {mode === 'return' && <p className="text-slate-600">Confirm the goods are physically back at the depot.</p>}
          {mode === 'cancel' && (
            <label className="min-w-64 flex-1 text-xs font-medium text-slate-600">
              Reason for cancelling
              <input
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                className="input mt-1 py-1.5"
                placeholder="e.g. Customer requested a refund"
              />
            </label>
          )}
          <button type="submit" className="btn-primary px-3 py-1.5" disabled={change.isPending}>
            {change.isPending
              ? 'Saving…'
              : mode === 'reschedule'
                ? 'Reschedule'
                : mode === 'return'
                  ? 'Mark returned'
                  : 'Cancel order'}
          </button>
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={() => setMode(null)}>
            Back
          </button>
          {change.isError && (
            <p role="alert" className="w-full text-xs text-danger">
              {change.error instanceof ApiError ? change.error.message : 'Could not update the order.'}
            </p>
          )}
        </form>
      )}
    </li>
  );
}
