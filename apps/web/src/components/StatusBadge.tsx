import { ORDER_STATUS_META, type OrderStatus, type StatusTone } from '@bedex/shared';
import {
  Ban,
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CircleX,
  Inbox,
  type LucideIcon,
  PackageMinus,
  Truck,
  Undo2,
  Warehouse,
} from 'lucide-react';
import { cn } from '../lib/cn';

/** One colour + icon per status, used everywhere: badges, map pins, timeline (PRD §4). */
export const STATUS_ICONS: Record<OrderStatus, LucideIcon> = {
  awaiting_scheduling: Inbox,
  in_warehouse: Warehouse,
  scheduled: CalendarCheck,
  out_for_delivery: Truck,
  delivered: CircleCheck,
  partially_delivered: PackageMinus,
  failed: CircleX,
  rescheduled: CalendarClock,
  returned_to_warehouse: Undo2,
  cancelled: Ban,
};

export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  brand: 'bg-brand-primary/10 text-brand-primary ring-brand-primary/20',
  info: 'bg-info/10 text-info ring-info/20',
  success: 'bg-success/10 text-success ring-success/20',
  warning: 'bg-warning/10 text-warning ring-warning/20',
  danger: 'bg-danger/10 text-danger ring-danger/20',
  muted: 'bg-slate-50 text-slate-500 ring-slate-200',
};

interface Props {
  status: OrderStatus;
  /** Use the customer-facing wording (tracking page). */
  customer?: boolean;
  size?: 'sm' | 'lg';
  className?: string;
}

export function StatusBadge({ status, customer = false, size = 'sm', className }: Props) {
  const meta = ORDER_STATUS_META[status];
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      <Icon aria-hidden className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      {customer ? meta.customerLabel : meta.label}
    </span>
  );
}
