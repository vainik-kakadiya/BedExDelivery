import { AlertTriangle, HelpCircle, Trash2, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { cn } from '../lib/cn';

type Tone = 'primary' | 'warning' | 'danger';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Shown as a bulleted list under the message (e.g. warnings). */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: destructive actions (delete, deactivate). warning: allowed but risky. */
  tone?: Tone;
}

interface Request extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Ask the user to confirm, in place of window.confirm():
 *   if (!(await confirmDialog({ title: 'Delete route?' }))) return;
 * Resolves true on confirm, false on cancel, Esc or a click outside.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // Only one at a time: a new request cancels one still open.
    useConfirmStore.getState().request?.resolve(false);
    useConfirmStore.setState({ request: { ...options, resolve } });
  });
}

const TONES: Record<Tone, { icon: LucideIcon; iconClass: string; button: string }> = {
  primary: { icon: HelpCircle, iconClass: 'bg-brand-primary/10 text-brand-primary', button: 'btn-primary' },
  warning: { icon: AlertTriangle, iconClass: 'bg-warning/10 text-warning', button: 'btn-primary' },
  danger: { icon: Trash2, iconClass: 'bg-danger/10 text-danger', button: 'btn bg-danger text-white hover:bg-danger/90' },
};

/** Mount once near the root; renders whichever confirmDialog() call is open. */
export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (request && !el.open) {
      el.showModal();
      // Focus Cancel for destructive actions so Enter doesn't delete by accident.
      el.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus();
    }
    if (!request && el.open) el.close();
  }, [request]);

  const settle = (ok: boolean) => {
    const current = useConfirmStore.getState().request;
    if (!current) return;
    useConfirmStore.setState({ request: null });
    current.resolve(ok);
  };

  const tone = TONES[request?.tone ?? 'primary'];
  const Icon = tone.icon;
  const danger = request?.tone === 'danger';

  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      // Esc: the browser closes the dialog; settle as a cancel.
      onCancel={(e) => {
        e.preventDefault();
        settle(false);
      }}
      // A click on the backdrop lands on the <dialog> itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
      className="w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-white p-0 text-ink shadow-2xl backdrop:bg-slate-900/50 backdrop:backdrop-blur-[2px] open:animate-[confirm-in_150ms_ease-out]"
    >
      {request && (
        <div className="p-6">
          <div className="flex gap-4">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', tone.iconClass)}>
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="confirm-title" className="text-base font-semibold">
                {request.title}
              </h2>
              <div id="confirm-message" className="mt-1.5 space-y-2 text-sm text-slate-600">
                {request.message && <div>{request.message}</div>}
                {request.details && request.details.length > 0 && (
                  <ul className="list-disc space-y-1 rounded-md bg-surface py-2 pl-8 pr-3">
                    {request.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-secondary min-h-tap sm:min-h-0" onClick={() => settle(false)} data-autofocus={danger || undefined}>
              {request.cancelLabel ?? 'Cancel'}
            </button>
            <button type="button" className={cn(tone.button, 'min-h-tap sm:min-h-0')} onClick={() => settle(true)} data-autofocus={!danger || undefined}>
              {request.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
