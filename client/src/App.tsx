import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';

const LoginPage = lazy(() => import('@/pages/LoginPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const SalesPage = lazy(() => import('@/pages/SalesPage'));
const ShiftPage = lazy(() => import('@/pages/ShiftPage'));
const PumpReadingsPage = lazy(() => import('@/pages/readings/PumpReadingsPage'));
const SalesReadingsPage = lazy(() => import('@/pages/readings/SalesReadingsPage'));
const ExpensesPage = lazy(() => import('@/pages/ExpensesPage'));
const CalendarPage = lazy(() => import('@/pages/CalendarPage'));
const RestockPage = lazy(() => import('@/pages/RestockPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const MonthlySummaryPage = lazy(() => import('@/pages/MonthlySummaryPage'));
const FuelManagementPage = lazy(() => import('@/pages/FuelManagementPage'));
const UsersPage = lazy(() => import('@/pages/UsersPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const AuditPage = lazy(() => import('@/pages/AuditPage'));
const BackupRestorePage = lazy(() => import('@/pages/BackupRestorePage'));
const ForbiddenPage = lazy(() => import('@/pages/ForbiddenPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader label="Checking your secure session…" />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user.mustChangePassword && location.pathname !== '/settings') return <Navigate to="/settings" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <ForbiddenPage />;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader label="Opening station workspace…" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="shift" element={<ShiftPage />} />
          <Route path="pump-readings" element={<PumpReadingsPage />} />
          <Route path="sales-readings" element={<SalesReadingsPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="restock" element={<RequireAdmin><RestockPage /></RequireAdmin>} />
          <Route path="reports" element={<RequireAdmin><ReportsPage /></RequireAdmin>} />
          <Route path="monthly-summary" element={<RequireAdmin><MonthlySummaryPage /></RequireAdmin>} />
          <Route path="fuel" element={<RequireAdmin><FuelManagementPage /></RequireAdmin>} />
          <Route path="users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
          <Route path="audit" element={<RequireAdmin><AuditPage /></RequireAdmin>} />
          <Route path="backup" element={<RequireAdmin><BackupRestorePage /></RequireAdmin>} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
