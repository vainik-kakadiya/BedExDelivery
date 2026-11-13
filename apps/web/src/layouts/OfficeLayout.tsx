import {
  Building2,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Package,
  Route as RouteIcon,
  Settings,
  Truck,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
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

  return (
    <div className="flex min-h-screen text-sm">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-white">
        <NavLink to="/office" className="flex h-16 items-center border-b border-border px-5" aria-label="BedEx Delivery – dashboard">
          <img src="/BedExLogo.png" alt="BedEx Delivery" width={412} height={137} className="h-9 w-auto" />
        </NavLink>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/office'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 font-medium text-slate-600 hover:bg-surface hover:text-ink',
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

      <main className="min-w-0 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
