import { useEffect } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Placeholder } from './components/Placeholder';
import { FullPageSpinner, RequireRole } from './components/RequireRole';
import { DriverLayout } from './layouts/DriverLayout';
import { OfficeLayout } from './layouts/OfficeLayout';
import { homePathFor, restoreSession } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { TrackPage } from './pages/TrackPage';
import { TodayPage } from './pages/driver/TodayPage';
import { OrdersPage } from './pages/office/OrdersPage';
import { DashboardPage } from './pages/office/dashboard/DashboardPage';
import { useAuth } from './stores/auth';

export function App() {
  useEffect(() => {
    void restoreSession();
  }, []);

  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/track" element={<TrackPage />} />

      <Route
        path="/office"
        element={
          <RequireRole roles={['admin', 'office']}>
            <OfficeLayout />
          </RequireRole>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="planner" element={<Placeholder title="Route planner" requirements="RTE-01 – RTE-10" milestone="weeks 4–5" />} />
        <Route path="drivers" element={<Placeholder title="Drivers" requirements="DRV-01, DRV-03 – DRV-05" milestone="weeks 2–3" />} />
        <Route path="vans" element={<Placeholder title="Vans" requirements="DRV-02" milestone="weeks 2–3" />} />
        <Route path="depots" element={<Placeholder title="Depots" requirements="RTE-02" milestone="weeks 2–3" />} />
        <Route path="settings" element={<Placeholder title="Settings" requirements="ACC-01, TRK-03/04 toggles" milestone="weeks 2–3" />} />
      </Route>

      <Route
        path="/driver"
        element={
          <RequireRole roles={['driver']}>
            <DriverLayout />
          </RequireRole>
        }
      >
        <Route index element={<TodayPage />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function HomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'unknown') return <FullPageSpinner />;
  return <Navigate to={user ? homePathFor(user.role) : '/login'} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/" className="text-brand-primary underline">
        Go to the portal
      </Link>
    </div>
  );
}
