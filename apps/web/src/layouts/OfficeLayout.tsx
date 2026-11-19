import {
  Building2,
  LayoutDashboard,
  LogOut,
  MapPinned,
  type LucideIcon,
  Package,
  Route as RouteIcon,
  Settings,
  Truck,
  Users,
  X,
  Menu,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { logout } from '../lib/api';
import { cn } from '../lib/cn';
import { type LiveStatus, useLiveStatus, useLiveUpdates } from '../lib/live';
import { useAuth } from '../stores/auth';

const LIVE_LABEL: Record<LiveStatus, { text: string; dot: string }> = {
  live: { text: 'Live updates on', dot: 'bg-success' },
  connecting: { text: 'Connecting…', dot: 'bg-warning' },
  offline: { text: 'Live updates paused – refreshing every 10 s', dot: 'bg-danger' },
};

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/office', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/office/orders', label: 'Orders', icon: Package },
  { to: '/office/planner', label: 'Route planner', icon: RouteIcon },
  { to: '/office/tracking', label: 'Live tracking', icon: MapPinned },
  { to: '/office/drivers', label: 'Drivers', icon: Users },
  { to: '/office/vans', label: 'Vans', icon: Truck },
  { to: '/office/depots', label: 'Depots', icon: Building2, adminOnly: true },
  { to: '/office/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

const ROLE_LABELS = { admin: 'Admin', office: 'Office', driver: 'Driver' } as const;

export function OfficeLayout() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const items = NAV.filter((i) => !i.adminOnly || user?.role === 'admin');
  useLiveUpdates();
  const live = LIVE_LABEL[useLiveStatus((s) => s.status)];
  const { pathname } = useLocation();
  const currentItem = items.find((i) => (i.to === '/office' ? pathname === '/office' : pathname.startsWith(i.to)));

  // Below lg the sidebar is a slide-in drawer, opened from the top bar.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    // Stop the page behind the drawer from scrolling.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [menuOpen]);

  return (
    <div className="min-h-screen text-sm lg:flex">
      {/* Mobile / tablet top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-white px-2 lg:hidden">
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-md text-slate-600 hover:bg-surface"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="office-nav"
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <NavLink to="/office" aria-label="BedEx Delivery – dashboard">
          <img src="/BedExLogo.png" alt="BedEx Delivery" width={412} height={137} className="h-7 w-auto" />
        </NavLink>
        {currentItem && <span className="ml-1 truncate font-medium text-slate-600">{currentItem.label}</span>}
        <span className={cn('ml-auto mr-2 h-2.5 w-2.5 shrink-0 rounded-full', live.dot)} title={live.text} role="status" aria-label={live.text} />
      </header>

      {/* Backdrop behind the drawer */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-slate-900/40 transition-opacity lg:hidden',
          menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-hidden
        onClick={() => setMenuOpen(false)}
      />

      <aside
        id="office-nav"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] flex-col border-r border-border bg-white transition-[transform,visibility] duration-200',
          'lg:visible lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-60 lg:shrink-0 lg:translate-x-0 lg:shadow-none lg:transition-none',
          // `invisible` also takes the closed drawer's links out of the tab order.
          menuOpen ? 'visible translate-x-0 shadow-2xl' : 'invisible -translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-border pl-5 pr-2">
          <NavLink to="/office" aria-label="BedEx Delivery – dashboard">
            <img src="/BedExLogo.png" alt="BedEx Delivery" width={412} height={137} className="h-9 w-auto" />
          </NavLink>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-surface lg:hidden"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/office'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 font-medium lg:py-2 text-slate-600 hover:bg-surface hover:text-ink',
                  isActive && 'bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/10 hover:text-brand-primary',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <p className="mb-3 flex items-center gap-2 px-2 text-xs text-slate-500" role="status">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', live.dot)} aria-hidden />
            {live.text}
          </p>
          <div className="mb-2 flex items-center gap-2 px-2">
            <p className="min-w-0 truncate font-medium text-ink" title={user?.name}>
              {user?.name}
            </p>
            {user && (
              <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-border">
                {ROLE_LABELS[user.role]}
              </span>
            )}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 font-medium text-slate-600 hover:bg-danger/10 hover:text-danger"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
