import React from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import StatusReportDashboard from './components/StatusReportDashboard';
import './App.css';

function DashboardApp() {
  const { token, loading, authError, login } = useAuth();

  if (loading) {
    return (
      <div className="app">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="app">
        <div className="login-container">
          <h1>Time Tracker - Status Report Dashboard</h1>
          <p>Sign in with your Atlassian account to access the admin dashboard.</p>
          {authError && <p className="auth-error">{authError}</p>}
          <button className="btn-login" onClick={login}>
            Sign in with Atlassian
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <StatusReportDashboard />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <DashboardApp />
    </AuthProvider>
  );
}

export default App;
