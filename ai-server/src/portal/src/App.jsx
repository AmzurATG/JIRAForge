import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy, startTransition } from 'react';
import { AuthProvider } from './contexts/AuthContext';

// Pages - Lazy loaded with prefetch hints
const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EmployeesPage = lazy(() => import('./pages/EmployeesPage'));
const EmployeeDetailPage = lazy(() => import('./pages/EmployeeDetailPage'));
const TimeLogsPage = lazy(() => import('./pages/TimeLogsPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

// Layout
import PageWrapper from './components/layout/PageWrapper';

// Loading fallback - minimal to prevent flash
const PageLoader = () => (
  <div className="flex items-center justify-center h-full py-8">
    <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
  </div>
);

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={
            <Suspense fallback={<PageLoader />}>
              <LoginPage />
            </Suspense>
          } />
          
          <Route path="/" element={<PageWrapper />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="employees/:userId" element={<EmployeeDetailPage />} />
            <Route path="time-logs" element={<TimeLogsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
