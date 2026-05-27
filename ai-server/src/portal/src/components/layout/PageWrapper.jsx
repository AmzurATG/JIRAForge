import { Outlet, Navigate } from 'react-router-dom';
import { useState, useEffect, Suspense } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import Sidebar from './Sidebar';
import Header from './Header';
import LoadingSpinner from '../common/LoadingSpinner';

function PageWrapper() {
  const { isAuthenticated, loading } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', JSON.stringify(sidebarCollapsed));
  }, [sidebarCollapsed]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
      <Sidebar 
        collapsed={sidebarCollapsed} 
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} 
      />
      <div className={`flex-1 flex flex-col transition-all duration-300 min-w-0 ${
        sidebarCollapsed ? 'ml-16' : 'ml-56'
      }`}>
        <Header />
        <main className="flex-1 overflow-x-hidden overflow-y-auto mt-12 p-4">
          <Suspense fallback={
            <div className="flex items-center justify-center h-full py-8">
              <LoadingSpinner size="sm" />
            </div>
          }>
            <div className="animate-fade-in max-w-full">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default PageWrapper;
