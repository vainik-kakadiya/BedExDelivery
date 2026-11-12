import type { DashboardCards } from '@bedex/shared';
import { CalendarClock, CircleX, Inbox, type LucideIcon, PackageMinus, Route as RouteIcon, Truck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../../lib/cn';

interface CardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon: LucideIcon;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  to?: string;
}

const TONE: Record<NonNullable<CardProps['tone']>, string> = {
  default: 'text-slate-500 bg-surface',
  danger: 'text-danger bg-danger/10',
  warning: 'text-warning bg-warning/10',
  success: 'text-success bg-success/10',
};

function Card({ label, value, hint, icon: Icon, tone = 'default', to }: CardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-slate-600">{label}</p>
        <span className={cn('rounded-md p-1.5', TONE[tone])}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </>
  );
  const className = 'card block p-4';
  const linkClass = cn(className, 'transition-colors hover:border-brand-primary/40');
  if (!to) return <div className={className}>{body}</div>;
  // In-page anchors need a plain link; React Router's Link doesn't scroll to hashes.
  return to.startsWith('#') ? (
    <a href={to} className={linkClass}>
      {body}
    </a>
  ) : (
    <Link to={to} className={linkClass}>
      {body}
    </Link>
  );
}

/** DSH-01. */
export function SummaryCards({ cards, date, isToday }: { cards: DashboardCards | undefined; date: string; isToday: boolean }) {
  const n = (v: number | undefined) => (v === undefined ? '–' : v);
  const day = isToday ? 'today' : 'that day';
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
      <Card
        label="Awaiting allocation"
        value={n(cards?.awaitingAllocation)}
        hint="Not yet on a route"
        icon={Inbox}
        to="/office/orders?status=awaiting_scheduling,in_warehouse,rescheduled"
      />
      <Card label={isToday ? "Today's routes" : 'Routes'} value={n(cards?.routesToday)} icon={RouteIcon} to="#routes" />
      <Card
        label="Stops completed"
        value={
          cards ? (
            <>
              {cards.stopsCompleted}
              <span className="text-base font-normal text-slate-400"> / {cards.stopsCompleted + cards.stopsOutstanding}</span>
            </>
          ) : (
            '–'
          )
        }
        hint={cards ? `${cards.stopsOutstanding} outstanding` : undefined}
        icon={Truck}
        tone="success"
        to={`/office/orders?date=${date}`}
      />
      <Card
        label="Failed"
        value={n(cards?.failedToday)}
        hint={`Attempts ${day}`}
        icon={CircleX}
        tone={cards?.failedToday ? 'danger' : 'default'}
        to="/office/orders?status=failed"
      />
      <Card
        label="Partially delivered"
        value={n(cards?.partialToday)}
        hint={`Attempts ${day}`}
        icon={PackageMinus}
        tone={cards?.partialToday ? 'warning' : 'default'}
        to="/office/orders?status=partially_delivered"
      />
      <Card
        label="Needs rescheduling"
        value={n(cards?.needsDecision)}
        hint="Waiting for a decision"
        icon={CalendarClock}
        tone={cards?.needsDecision ? 'warning' : 'default'}
        to="#action-queue"
      />
    </div>
  );
}
