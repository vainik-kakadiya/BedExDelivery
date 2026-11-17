import type { ExportFormat } from '@bedex/shared';
import { ChevronDown, Download, FileSpreadsheet, FileText, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, downloadFile } from '../lib/api';
import { cn } from '../lib/cn';

interface Props {
  /** API path for a format, e.g. (f) => `/exports/orders?format=${f}` */
  path: (format: ExportFormat) => string;
  formats?: ExportFormat[];
  /** Button text; defaults to "Export". */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

const FORMAT_META: Record<ExportFormat, { label: string; icon: LucideIcon }> = {
  csv: { label: 'CSV', icon: FileText },
  xlsx: { label: 'Excel (.xlsx)', icon: FileSpreadsheet },
  pdf: { label: 'PDF', icon: FileText },
};

const MENU_WIDTH = 176;
const MENU_GAP = 4;

/**
 * DSH-06: one "Export" button that opens a menu of file formats; downloads with the user's token.
 * The menu is portalled to <body> with fixed positioning so scroll/overflow containers
 * (tables, cards) never clip it.
 */
export function ExportMenu({ path, formats = ['csv', 'xlsx', 'pdf'], label = 'Export', size = 'md', className }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Place the menu under the trigger, right-aligned; flip above when there's no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const r = trigger.getBoundingClientRect();
    const h = menu.offsetHeight;
    const below = r.bottom + MENU_GAP;
    const top = below + h > window.innerHeight - 8 && r.top - MENU_GAP - h > 8 ? r.top - MENU_GAP - h : below;
    const left = Math.min(Math.max(8, r.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
    setPos({ top, left });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Close on outside click, scroll or resize (a fixed menu would otherwise drift from its button).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onResize = () => close();
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const run = async (format: ExportFormat) => {
    close(true);
    setBusy(format);
    setError(null);
    try {
      await downloadFile(path(format));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Download failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (n: number) => items[(n + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusAt(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusAt(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(items.length - 1);
        break;
    }
  };

  const sm = size === 'sm';

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn('btn-secondary', sm ? 'gap-1 px-2 py-0.5 text-xs' : 'px-3 py-1.5')}
      >
        <Download className={sm ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden />
        {busy ? `Exporting ${busy.toUpperCase()}…` : label}
        <ChevronDown className={cn(sm ? 'h-3 w-3' : 'h-3.5 w-3.5', 'transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`${label} format`}
            onKeyDown={onMenuKeyDown}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: MENU_WIDTH, visibility: pos ? 'visible' : 'hidden' }}
            className="card fixed z-50 py-1 text-sm shadow-lg"
          >
            {formats.map((f) => {
              const { label: name, icon: Icon } = FORMAT_META[f];
              return (
                <button
                  key={f}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => run(f)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink hover:bg-surface focus:bg-surface focus:outline-none"
                >
                  <Icon className="h-4 w-4 text-slate-500" aria-hidden />
                  {name}
                </button>
              );
            })}
          </div>,
          document.body,
        )}

      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
