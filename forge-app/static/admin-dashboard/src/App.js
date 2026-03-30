import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import StatusReportDashboard from './components/StatusReportDashboard';
import './App.css';

function App() {
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    checkPermissions();
  }, []);

  const checkPermissions = async () => {
    try {
      const result = await invoke('getUserPermissions');
      if (result.success) {
        setIsAdmin(result.permissions.isJiraAdmin);
      }
    } catch (err) {
      console.error('Failed to check permissions:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Checking permissions...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="app">
        <div className="access-denied">
          <h1>Access Denied</h1>
          <p>Only Jira Administrators can access the Status Report Dashboard.</p>
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

export default App;
