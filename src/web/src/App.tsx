import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './state/session';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { PosPage } from './pages/Pos';
import { Spinner } from './components/ui';

// The POS stays bundled eagerly even though the dashboard is now the landing
// page: it is the screen an operator lives in, and navigating to it from the
// dashboard must be instant. Everything else is split out so its weight - the
// chart library in particular, at 110 KB gzipped - never lands on the counter.
const DashboardPage = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.DashboardPage })));
const SalesPage = lazy(() => import('./pages/Sales').then((m) => ({ default: m.SalesPage })));
const CustomersPage = lazy(() => import('./pages/Customers').then((m) => ({ default: m.CustomersPage })));
const PaymentsPage = lazy(() => import('./pages/Payments').then((m) => ({ default: m.PaymentsPage })));
const StockPage = lazy(() => import('./pages/Stock').then((m) => ({ default: m.StockPage })));
const ExpensesPage = lazy(() => import('./pages/Expenses').then((m) => ({ default: m.ExpensesPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((m) => ({ default: m.ReportsPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));

export function App() {
  const { user, loading } = useSession();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Starting" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          {/* Dashboard is the landing page; the till lives at /sell. */}
          <Route path="/" element={<DashboardPage />} />
          <Route path="/sell" element={<PosPage />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route
            path="/admin"
            element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
