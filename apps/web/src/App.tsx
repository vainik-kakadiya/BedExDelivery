import { useEffect } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ConfirmHost } from './components/ConfirmDialog';
import { FullPageSpinner, RequireRole } from './components/RequireRole';
import { DriverLayout } from './layouts/DriverLayout';
import { OfficeLayout } from './layouts/OfficeLayout';
import { homePathFor, restoreSession } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { TrackPage } from './pages/TrackPage';
import { StopPage } from './pages/driver/StopPage';
import { TodayPage } from './pages/driver/TodayPage';
import { DepotsPage } from './pages/office/DepotsPage';
import { ImportOrdersPage } from './pages/office/ImportOrdersPage';
import { OrderDetailPage } from './pages/office/OrderDetailPage';
import { OrdersPage } from './pages/office/OrdersPage';
import { SettingsPage } from './pages/office/SettingsPage';
import { DashboardPage } from './pages/office/dashboard/DashboardPage';
import { DriversPage } from './pages/office/fleet/DriversPage';
import { VansPage } from './pages/office/fleet/VansPage';
import { PlannerPage } from './pages/office/planner/PlannerPage';
import { TrackingPage } from './pages/office/tracking/TrackingPage';
import { useAuth } from './stores/auth';

export function App() {
  useEffect(() => {
    void restoreSession();
  }, []);

  return (
    <>
      <AppRoutes />
      <ConfirmHost />
    </>
  );
}

function AppRoutes() {
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
        <Route path="orders/import" element={<ImportOrdersPage />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        <Route path="planner" element={<PlannerPage />} />
        <Route path="tracking" element={<TrackingPage />} />
        <Route path="drivers" element={<DriversPage />} />
        <Route path="vans" element={<VansPage />} />
        <Route path="depots" element={<DepotsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route
        path="/driver"
        element={
          <RequireRole roles={['driver']}>
            <DriverLayout />
          </RequireRole>
        }
      >
        <Route index element={<TodayPage view="todo" />} />
        <Route path="completed" element={<TodayPage view="done" />} />
        <Route path="stops/:stopId" element={<StopPage />} />
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
