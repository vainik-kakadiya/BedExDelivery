import { ListChecks, LogOut, WifiOff } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { logout } from '../lib/api';
import { useOnline } from '../lib/hooks';

/** Mobile-first: 16px base text, 48px tap targets, bottom action bar (PRD §4). */
export function DriverLayout() {
  const online = useOnline();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col text-base">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between bg-brand-dark px-4 text-white">
        <Logo inverted className="text-lg" />
        <button
          type="button"
          aria-label="Sign out"
          className="flex min-h-tap min-w-tap items-center justify-center"
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

      <nav className="fixed inset-x-0 bottom-0 border-t border-border bg-white pb-[env(safe-area-inset-bottom)]">
        <NavLink
          to="/driver"
          end
          className="flex min-h-tap flex-col items-center justify-center py-2 text-sm font-medium text-brand-primary"
        >
          <ListChecks className="h-6 w-6" aria-hidden />
          Today
        </NavLink>
      </nav>
    </div>
  );
}
