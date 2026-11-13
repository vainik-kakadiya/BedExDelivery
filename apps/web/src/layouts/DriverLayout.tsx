import { useQueryClient } from '@tanstack/react-query';
import { CircleCheckBig, ListChecks, LogOut, type LucideIcon, WifiOff } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout } from '../lib/api';
import { cn } from '../lib/cn';
import { DRIVER_TODAY_KEY, countStops, useDriverToday } from '../lib/driverRoute';
import { useOnline } from '../lib/hooks';
import { useEventStream } from '../lib/live';

/** Mobile-first: 16px base text, 48px tap targets, bottom action bar (PRD §4). */
export function DriverLayout() {
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const counts = countStops(useDriverToday().data);
  // DRV-05 / RTE-09: office changes reach both tabs instantly (one stream for the whole app).
  useEventStream('/driver/stream', () => void queryClient.invalidateQueries({ queryKey: DRIVER_TODAY_KEY }));

  return (
    <div className="flex min-h-screen flex-col text-base">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-white px-4 text-ink">
        <img src="/BedExLogo.png" alt="BedEx Delivery" width={412} height={137} className="h-8 w-auto" />
        <button
          type="button"
          aria-label="Sign out"
          className="-mr-2 flex min-h-tap min-w-tap items-center justify-center rounded-md text-slate-600 hover:bg-surface hover:text-ink"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          <LogOut className="h-5 w-5" aria-hidden />
        </button>
      </header>

      {!online && (
        // DRP-06: will show "Offline – N updates waiting" once the IndexedDB queue lands.
        <div role="status" className="flex items-center gap-2 bg-warning px-4 py-2 font-medium text-white">
          <WifiOff className="h-5 w-5" aria-hidden />
          Offline – updates will sync when you reconnect
        </div>
      )}

      <main className="flex-1 px-4 pb-24 pt-4">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 grid grid-cols-2 border-t border-border bg-white pb-[env(safe-area-inset-bottom)]">
        <Tab to="/driver" end icon={ListChecks} label="Today" count={counts.todo} />
        <Tab to="/driver/completed" icon={CircleCheckBig} label="Completed" count={counts.done} />
      </nav>
    </div>
  );
}

function Tab({ to, end, icon: Icon, label, count }: { to: string; end?: boolean; icon: LucideIcon; label: string; count: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'relative flex min-h-tap flex-col items-center justify-center py-2 text-sm font-medium',
          isActive ? 'text-brand-primary' : 'text-slate-500',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-brand-primary" aria-hidden />}
          <span className="relative">
            <Icon className="h-6 w-6" aria-hidden />
            {count > 0 && (
              <span className="absolute -right-3 -top-1.5 min-w-5 rounded-full bg-brand-primary px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
                {count}
              </span>
            )}
          </span>
          {label}
        </>
      )}
    </NavLink>
  );
}
